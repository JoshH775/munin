import { z } from 'zod'
import { normalizeUrl } from '../../urls'
import { makeTool } from '../makeTool'
import { log } from '../../logger'

const keys = [process.env.TAVILY_API_KEY, process.env.OTHER_TAVILY_API_KEY].filter(Boolean) as string[]

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

async function tavilyFetch(path: string, body: Record<string, unknown>): Promise<Response> {
  for (const key of keys) {
    const res = await fetch(`https://api.tavily.com/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
    })
    if (res.ok) return res
    if (res.status === 401 || res.status === 429 || res.status === 432) continue
    throw new Error(`Tavily ${path} failed: ${res.status} ${await res.text()}`)
  }
  throw new Error('All Tavily API keys exhausted')
}

export function tavilySearchTool(trustedUrls: Set<string>) {
  return makeTool({
    name: 'web_search',
    label: (n) => (n === 1 ? 'Searched the web' : `Ran ${n} web searches`),
    description:
      'Search the web for current or factual information. Returns the top few results as title, ' +
      'URL, and a short snippet, which is usually enough to answer from directly. Reach for it when ' +
      'a question turns on something you do not know or that may have changed. Budget: at most 5 ' +
      'searches per turn, and usually 1-2 is enough. Combine related questions into a single broad ' +
      'query rather than splitting them.',
    inputSchema: z.object({
      query: z.string().describe('The search query.'),
    }),
    run: async ({ query }) => {
      if (keys.length === 0) return 'Web search is unavailable: no Tavily API keys set.'
      try {
        const res = await tavilyFetch('search', { query, search_depth: 'basic', max_results: 6 })
        const { results } = (await res.json()) as { results: { title: string; url: string; score: number; content: string }[] }
        if (results.length === 0) return `No results for "${query}".`

        for (const r of results) {
          const norm = normalizeUrl(r.url)
          if (norm) trustedUrls.add(norm)
        }
        return results
          .map((r) => `${r.title} (score ${r.score.toFixed(2)})\n${r.url}\n${r.content}`)
          .join('\n\n')
      } catch (err) {
        console.error('Tavily search failed', err)
        return `Web search failed: ${String(err)}`
      }
    },
    readsUntrusted: true,
  })
}

export function tavilyExtractTool(trustedUrls: Set<string>) {
  return makeTool({
    name: 'web_extract',
    label: (n) => `Read ${plural(n, 'page')}`,
    description:
      'Open one or more web pages by URL and read their real content, beyond the snippet a ' +
      'search returns. Use it to verify a detail or read something in full when a snippet is ' +
      'ambiguous or not enough. Pass several URLs to cross-check a claim across sources, and pass ' +
      'what you are checking as `query` to focus on the relevant parts of each page. You can ' +
      'only open URLs that came from a web_search result or that the user shared, so search ' +
      'first when you need a page you do not yet have a URL for.',
    inputSchema: z.object({
      urls: z.array(z.url()),
      query: z.string().optional(),
    }),
    run: async ({ urls, query }) => {
      if (keys.length === 0) return 'Web extract is unavailable: no Tavily API keys set.'

      const allowed: string[] = []
      const blocked: string[] = []
      for (const u of urls) {
        const norm = normalizeUrl(u)
        if (norm && trustedUrls.has(norm)) allowed.push(u)
        else blocked.push(u)
      }
      if (allowed.length === 0) {
        return `Refused: none of those URLs came from a search result or the conversation, so they can't be opened. Run web_search first, then extract from the URLs it returns. Blocked: ${blocked.join(', ')}`
      }

      try {
        const res = await tavilyFetch('extract', {
          urls: allowed,
          format: 'markdown',
          ...(query ? { query, chunks_per_source: 5 } : {}),
        })
        const { results, failed_results } = (await res.json()) as {
          results: { url: string; title: string; raw_content: string }[]
          failed_results: { url: string; error: string }[]
        }

        const rows = results.map((r) => {
          let content = r.raw_content
          if (content.length >= 3000) {
            log.warn({ url: r.url, chars: content.length }, 'Extract content truncated')
            content = `${content.slice(0, 2950)}\n\n[content truncated]`
          }
          return `${r.title} - ${r.url}\n\n${content}`
        })
        for (const f of failed_results) {
          rows.push(`${f.url}\n\nCouldn't open: ${f.error}`)
        }
        if (blocked.length) {
          rows.push(`Refused (not from a search result or the conversation): ${blocked.join(', ')}`)
        }
        return rows.length ? rows.join('\n\n') : 'No content returned.'
      } catch (err) {
        console.error('Tavily extract failed', err)
        return `Web extraction failed: ${String(err)}`
      }
    },
    readsUntrusted: true,
  })
}

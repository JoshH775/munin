import { z } from 'zod'
import { tavily } from '@tavily/core'
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { makeTool } from './makeTool'
import { updateMemory } from '../repositories/channelSettings'

const apiKey = process.env.TAVILY_API_KEY
const tavilyClient = apiKey ? tavily({ apiKey }) : null

// Client-side web search via Tavily. Returns clean, ranked snippets; the SDK types the response.
export function tavilySearchTool() {
  return makeTool({
    name: 'web_search',
    description:
      'Search the web for current or factual information. Returns the top few results as title, ' +
      'URL, and a short snippet, which is usually enough to answer from directly. Reach for it when ' +
      'a question turns on something you do not know or that may have changed. Make each query count ' +
      'rather than firing off several.',
    inputSchema: z.object({
      query: z.string().describe('The search query.')
    }),
    run: async ({ query }) => {
      if (!tavilyClient) return 'Web search is unavailable: TAVILY_API_KEY is not set.'
      try {
        const { results } = await tavilyClient.search(query, {
          searchDepth: 'advanced',
          maxResults: 8
        })
        if (results.length === 0) return `No results for "${query}".`
        return results
          .map((r) => `${r.title} (score ${r.score.toFixed(2)})\n${r.url}\n${r.content}`)
          .join('\n\n')
      } catch (err) {
        console.error('Tavily search failed', err)
        return `Web search failed: ${String(err)}`
      }
    }
  })
}

export function tavilyExtractTool() {
  return makeTool({
    name: 'web_extract',
    description:
      'Open one or more web pages by URL and read their real content, beyond the snippet a ' +
      'search returns. Use it to verify a detail or read something in full when a snippet is ' +
      'ambiguous or not enough. Pass several URLs to cross-check a claim across sources, and pass ' +
      'what you are checking as `query` to focus on the relevant parts of each page.',
    inputSchema: z.object({
      urls: z.array(z.url()),
      query: z.string().optional()
    }),
    run: async ({ urls, query }) => {
      if (!tavilyClient) return 'Web search is unavailable: TAVILY_API_KEY is not set.'

      try {
        const { results, failedResults } = await tavilyClient.extract(urls, {
          format: 'markdown',
          ...(query ? { query, chunksPerSource: 5 } : {})
        })

        const rows = results.map((r) => {
          const content =
            r.rawContent.length < 3000
              ? r.rawContent
              : `${r.rawContent.slice(0, 2950)}\n\n[content truncated]`
          return `${r.title} - ${r.url}\n\n${content}`
        })
        for (const f of failedResults) {
          rows.push(`${f.url}\n\nCouldn't open: ${f.error}`)
        }
        return rows.length ? rows.join('\n\n') : 'No content returned.'

      } catch (err) {
        console.error('Tavily extract failed', err)
        return `Web extraction failed: ${String(err)}`
      }
        
    
    }
  })
}

export function updateMemoryTool(
  channelId: string,
  parentChannelId: string | null
) {
  const isThread = parentChannelId !== null
  return makeTool({
    name: 'update_memory',
    description:
      "Rewrite memory. Memory is a living document you keep current, not a log: pass the full new text for a tier, preserving what still matters and folding in anything worth remembering. Each field replaces that tier's memory entirely, so never send a fragment or a diff. " +
      (isThread
        ? "You are in a thread. `memory` is this thread's own memory. `parentMemory` is the parent channel's memory, shared across the whole channel; set it only for facts that belong at that broader scope."
        : "You are in a channel. `memory` is this channel's own memory. `parentMemory` is the global memory, shared across every channel; set it only for facts that belong at that broadest scope.") +
      ' Omit a field to leave that tier untouched; provide at least one.',
    inputSchema: z.object({
      memory: z
        .string()
        .optional()
        .describe(
          isThread
            ? "This thread's updated memory document."
            : "This channel's updated memory document."
        ),
      parentMemory: z
        .string()
        .optional()
        .describe(
          isThread
            ? "The parent channel's updated memory document, shared across the whole channel."
            : 'The global memory document, shared across every channel.'
        )
    }),
    run: async ({ memory, parentMemory }) => {
      const updated: string[] = []
      if (memory !== undefined) {
        await updateMemory({ channelId, memory })
        updated.push(isThread ? 'thread memory' : 'channel memory')
      }
      if (parentMemory !== undefined) {
        await updateMemory({
          channelId: parentChannelId ?? 'global',
          memory: parentMemory
        })
        updated.push(isThread ? 'channel memory' : 'global memory')
      }
      if (updated.length === 0) return 'No memory provided; nothing updated.'
      return `Updated ${updated.join(' and ')}.`
    }
  })
}

// Hands real work off to a Claude Code session in a detached tmux session. munin dispatches
// and reports back; it never does the work itself. `env -u ANTHROPIC_API_KEY` strips munin's
// personal key from the child, so the spawned session uses the machine's Claude Code login.
export function startWorkTool(channelName: string) {
  const slug =
    channelName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'work'
  return makeTool({
    name: 'start_work',
    description:
      'Dispatch a coding task to a Claude Code session running in a detached tmux session on this machine. ' +
      'Use this to hand real work off to Claude Code — you never do the work yourself. ' +
      'The session opens in ~/projects/<channel> and begins by planning the task (`/plan <task>`). ' +
      'It returns immediately and runs in the background. Write a clear, self-contained task: the session ' +
      'has none of this conversation as context.',
    inputSchema: z.object({
      task: z
        .string()
        .describe(
          'A clear, self-contained description of the work to plan and carry out.'
        )
    }),
    run: async ({ task }) => {
      const dir = join(
        process.env.WORK_DIR || join(homedir(), 'projects'),
        slug
      )
      const session = `munin-${slug}`
      mkdirSync(dir, { recursive: true })
      try {
        execFileSync('tmux', ['has-session', '-t', session], {
          stdio: 'ignore'
        })
        return `A work session (${session}) is already running for this channel; leaving it alone. Attach with \`tmux attach -t ${session}\`.`
      } catch {
        // no session by that name; create one
      }
      execFileSync('tmux', [
        'new-session',
        '-d',
        '-s',
        session,
        '-c',
        dir,
        'env',
        '-u',
        'ANTHROPIC_API_KEY',
        'claude',
        `/plan ${task}`
      ])
      return `Launched an interactive Claude Code session in ${dir} (tmux session ${session}) to plan: ${task}. Attach with \`tmux attach -t ${session}\` to watch or continue.`
    }
  })
}

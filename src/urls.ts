import { LinkifyIt } from 'linkify-it'

const linkify = new LinkifyIt()

// Normalise a URL for exact-match comparison: drop the fragment, keep path and query intact.
export function normalizeUrl(raw: string): string | null {
  try {
    const url = new URL(raw)
    url.hash = ''
    return url.href
  } catch {
    return null
  }
}

// Normalised http(s) URLs found in arbitrary text.
export function findUrls(text: string): string[] {
  const out: string[] = []
  for (const match of linkify.match(text) ?? []) {
    if (!/^https?:\/\//i.test(match.url)) continue // web pages only; skip mailto and the like
    const norm = normalizeUrl(match.url)
    if (norm) out.push(norm)
  }
  return out
}

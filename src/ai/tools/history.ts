import { z } from 'zod'
import { makeTool } from '../makeTool'
import { searchMessages } from '../../repositories/messages'
import { searchToolLog } from '../../repositories/toolLog'
import { parseTime } from '../../time'

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

export function searchMessagesTool() {
  return makeTool({
    name: 'search_messages',
    label: (n) => `Searched messages ${plural(n, 'time')}`,
    description:
      'Search the stored message history, reaching past the recent messages you are shown for the ' +
      'current channel. Use it when the user refers back to something older than what is in front of ' +
      'you, or asks what was said about a topic. It matches messages whose text contains the `query`, ' +
      'across every channel unless you scope it with `channelId`, and returns them newest first with ' +
      'the channel, author, and time of each. Your own past replies are included, so you can look up ' +
      'what you said as well as what was said to you; only your status lines are left out.',
    inputSchema: z.object({
      query: z.string().optional().describe('Search term to match in message content.'),
      channelId: z.string().optional().describe('Optional channel to restrict the search to.'),
      limit: z
        .number()
        .optional()
        .describe('Optional maximum number of results to return. Default is 50.'),
      since: z.iso
        .datetime({ local: true })
        .optional()
        .describe(
          'Optional London local time (ISO 8601, no zone suffix) to restrict the search to messages sent after it.',
        ),
    }),
    run: async (args) => {
      const { query, channelId, limit = 50, since } = args
      const results = await searchMessages({
        query,
        channelId,
        limit,
        since: since ? parseTime(since) : undefined,
      })
      return JSON.stringify(
        results.map(({ created_at, kind, ...m }) => ({
          ...m,
          sent_at: m.sent_at.tz().format('YYYY-MM-DD HH:mm'),
        })),
      )
    },
  })
}

export function toolLogTool(channelId: string) {
  return makeTool({
    name: 'tool_log',
    label: (n) => `Checked the tool log ${plural(n, 'time')}`,
    description:
      'Look back at your own past tool calls: which tool ran, when, how long it took, and whether ' +
      'it failed or was blocked and why. Use it when asked what you did, why something went wrong, ' +
      'or how a tool has been behaving. Scoped to the current channel unless you pass `channelId`. ' +
      'Newest first.',
    inputSchema: z.object({
      channelId: z.string().optional().describe('Channel to look at. Defaults to the current one.'),
      tool: z.string().optional().describe('Restrict to one tool by name.'),
      errorsOnly: z.boolean().optional().describe('Only calls that failed or were blocked.'),
      since: z.iso
        .datetime({ local: true })
        .optional()
        .describe('London local time (ISO 8601, no zone suffix); only calls after it.'),
      limit: z.number().optional().describe('Maximum rows to return. Default is 50.'),
    }),
    readsUntrusted: true,
    run: async ({ channelId: scope = channelId, tool, errorsOnly, since, limit = 50 }) => {
      const rows = await searchToolLog({
        channelId: scope,
        tool,
        errorsOnly,
        since: since ? parseTime(since) : undefined,
        limit,
      })
      return JSON.stringify(
        rows.map((r) => ({
          at: r.created_at.tz().format('YYYY-MM-DD HH:mm:ss'),
          tool: r.tool,
          ok: !r.error,
          ms: r.duration_ms,
          input: JSON.stringify(r.input).slice(0, 200),
          ...(r.error && { error: r.error }),
        })),
      )
    },
  })
}

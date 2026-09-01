import { z } from 'zod'
import { tavily } from '@tavily/core'
import { normalizeUrl } from '../urls'
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { makeTool } from './makeTool'
import { updateMemory } from '../repositories/channelSettings'
import { CategoryChannel, ChannelType, Guild, TextChannel, type Client } from 'discord.js'
import { log } from '../logger'
import { insertNewReminder, cancelReminder, getPendingReminders } from '../repositories/reminders'

const apiKey = process.env.TAVILY_API_KEY
const tavilyClient = apiKey ? tavily({ apiKey }) : null

// Client-side web search via Tavily. Returns clean, ranked snippets; the SDK types the response.
export function tavilySearchTool(trustedUrls: Set<string>) {
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
          searchDepth: 'basic',
          maxResults: 6
        })
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
    readsUntrusted: true
  })
}

export function tavilyExtractTool(trustedUrls: Set<string>) {
  return makeTool({
    name: 'web_extract',
    description:
      'Open one or more web pages by URL and read their real content, beyond the snippet a ' +
      'search returns. Use it to verify a detail or read something in full when a snippet is ' +
      'ambiguous or not enough. Pass several URLs to cross-check a claim across sources, and pass ' +
      'what you are checking as `query` to focus on the relevant parts of each page. You can ' +
      'only open URLs that came from a web_search result or that the user shared, so search ' +
      'first when you need a page you do not yet have a URL for.',
    inputSchema: z.object({
      urls: z.array(z.url()),
      query: z.string().optional()
    }),
    run: async ({ urls, query }) => {
      if (!tavilyClient) return 'Web search is unavailable: TAVILY_API_KEY is not set.'

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
        const { results, failedResults } = await tavilyClient.extract(allowed, {
          format: 'markdown',
          ...(query ? { query, chunksPerSource: 5 } : {})
        })

        const rows = results.map((r) => {
          let content = r.rawContent
          if (content.length >= 3000) {
            log.warn({ url: r.url, chars: content.length }, 'Extract content truncated')
            content = `${content.slice(0, 2950)}\n\n[content truncated]`
          }
          return `${r.title} - ${r.url}\n\n${content}`
        })
        for (const f of failedResults) {
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
    readsUntrusted: true
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
    },
    // Launches an arbitrary Claude Code session: the strongest arbitrary-outreach tool there is.
    arbitraryOutreach: true
  })
}

export function channelTreeTool(client: Client) {
  return makeTool({
    name: 'channel_tree',
    description:
      "Show the server's channels grouped by category, each channel and category with its id. Reach for it to see what exists and grab the ids you need before linking a channel with `<#id>`, creating or deleting a category, or moving a channel.",
    inputSchema: z.object({}),
    run: () => {

      const renderChildren = (channels: TextChannel[]) => {
        return channels.map((c) => `- #${c.name} (${c.id})`).join('\n')
      }

      const categories = client.channels.cache.values().filter((c): c is CategoryChannel => c.type === ChannelType.GuildCategory).toArray().sort((a, b) => a.position - b.position)
      const channelsByCategories = new Map<CategoryChannel | null, TextChannel[]>()
      categories.forEach((c) => channelsByCategories.set(c, []))
      const textChannels = client.channels.cache.values().filter((c): c is TextChannel => c.type === ChannelType.GuildText).toArray().sort((a, b) => a.position - b.position)
      for (const channel of textChannels) {
        const existing = channelsByCategories.get(channel.parent) ?? []
        channelsByCategories.set(channel.parent, [...existing, channel])
      }

      return channelsByCategories.entries().map(([category, channels]) => `${category ? `${category.name} (${category.id})` : 'No Category'}\n${renderChildren(channels)}`).toArray().join('\n\n')
    }
  })
}

export function createCategoryTool(client: Client, guild: Guild) {
  return makeTool({
    name: 'create_category',
    description:
      'Create a new empty category by name and return its id, so you can then move channels into it. Fails if a category with that name already exists.',
    inputSchema: z.object({
      name: z.string().describe('The name for the new category.')
    }),
    run: async (args) => {
      const existingNames = client.channels.cache.values().filter((c): c is CategoryChannel => c.type === ChannelType.GuildCategory).toArray().map((c) => c.name.toLowerCase())
      if (existingNames.includes(args.name.toLowerCase())) {
        throw new Error(`A category named "${args.name}" already exists.`)
      }

      const category = await guild.channels.create({
        name: args.name,
        type: ChannelType.GuildCategory
      })

      return `Created category "${args.name}" (${category.id}).`

    }
  })
}

export function deleteCategoryTool(client: Client) {
  return makeTool({
    name: 'delete_category',
    description:
      'Delete a category by id. Its channels are not deleted — they just become uncategorised. Reports how many were orphaned.',
    inputSchema: z.object({
      categoryId: z.string().describe('The id of the category to delete.')
    }),
    run: async ({ categoryId }) => {
      const category = client.channels.cache.get(categoryId)
      if (category?.type !== ChannelType.GuildCategory) {
        throw new Error(`No category found with id ${categoryId}.`)
      }
      const orphaned = category.children.cache.size
      const { name } = category
      await category.delete()
      return (
        `Deleted category "${name}".` +
        (orphaned ? ` ${orphaned} channel${orphaned === 1 ? '' : 's'} now uncategorised.` : '')
      )
    }
  })
}

export function setChannelCategoryTool(client: Client) {
  return makeTool({
    name: 'set_channel_category',
    description:
      'Move a text channel into a category, or out of any category. Pass the channel id and the target category id (or null to remove it from its category). Get the ids from channel_tree.',
    inputSchema: z.object({
      channelId: z.string().describe('The id of the channel to move.'),
      categoryId: z
        .string()
        .nullable()
        .describe('The id of the category to move it into, or null to remove it from any category.')
    }),
    run: async ({ channelId, categoryId }) => {
      const channel = client.channels.cache.get(channelId)
      if (channel?.type !== ChannelType.GuildText) {
        throw new Error(`No text channel found with id ${channelId}.`)
      }
      let categoryName: string | null = null
      if (categoryId !== null) {
        const category = client.channels.cache.get(categoryId)
        if (category?.type !== ChannelType.GuildCategory) {
          throw new Error(`No category found with id ${categoryId}.`)
        }
        categoryName = category.name
      }
      await channel.setParent(categoryId, { lockPermissions: false })
      return categoryName
        ? `Moved #${channel.name} into "${categoryName}".`
        : `Removed #${channel.name} from its category.`
    }
  })
}
 

export function createReminderTool(client: Client, setById: string) {
  return makeTool({
    name: 'set_reminder',
    description:
      'Schedule a one-off message to be posted in a channel at a future time. Give the time as a ' +
      'UTC ISO 8601 datetime ending in Z (e.g. 2026-09-01T14:30:00Z); the current time in UTC is ' +
      'in your context, so work forward from that. It fires within about a minute of the given time. ' +
      'Pass the id of the text channel to post in (use channel_tree to find ids). Returns the ' +
      "reminder's id, which delete_reminder needs to cancel it.",
    inputSchema: z.object({
      date: z.iso.datetime().describe('When to fire, as a UTC ISO 8601 datetime ending in Z.'),
      content: z.string().max(1800).describe('The reminder message to post.'),
      channelId: z.string().describe('The id of the text channel to post the reminder in.')
    }),
    run: async ({ channelId, content, date }) => {
      const isGuildText = client.channels.cache
        .values()
        .filter((c): c is TextChannel => c.type === ChannelType.GuildText)
        .toArray()
        .some((c) => c.id === channelId)
      if (!isGuildText) {
        throw new Error(
          'No text channel with that id. Call channel_tree for the list of channels and ids.'
        )
      }
      const { id } = await insertNewReminder({ channel_id: channelId, content, date, target: setById })
      return `Reminder set for ${date} in <#${channelId}> (id ${id}).`
    }
  })
}

export function deleteReminderTool() {
  return makeTool({
    name: 'delete_reminder',
    description:
      'Cancel a pending reminder by its id so it never fires. The id is the one set_reminder ' +
      'returned. Does nothing if the reminder has already fired or the id is unknown.',
    inputSchema: z.object({
      id: z.uuid().describe('The id of the reminder to cancel.')
    }),
    run: async ({ id }) => {
      const cancelled = await cancelReminder(id)
      return cancelled > 0 ? `Cancelled reminder ${id}.` : `No pending reminder with id ${id}.`
    }
  })
}

export function listRemindersTool() {
  return makeTool({
    name: 'list_reminders',
    description:
      'List every pending reminder with its id, time, channel, and content, so you can tell the ' +
      'user what is scheduled or find the id to cancel one with delete_reminder.',
    inputSchema: z.object({}),
    run: async () => {
      const reminders = await getPendingReminders()
      if (reminders.length === 0) return 'No pending reminders.'
      return reminders
        .map((r) => `${r.id} — ${r.date.toISOString()} — <#${r.channel_id}> — ${r.content}`)
        .join('\n')
    }
  })
}
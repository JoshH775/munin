import {
  Collection,
  type AnyThreadChannel,
  type Channel,
  type ForumChannel,
  type Guild,
  type GuildMember,
  type MediaChannel,
  type Message,
  type NewsChannel,
  type TextChannel,
} from 'discord.js'
import type { Tool } from '../ai/makeTool'

// Chunk text to fit Discord's 2000-char message limit, breaking on newlines where possible.
export function splitForDiscord(text: string): string[] {
  const parts: string[] = []
  let rest = text
  while (rest.length > 2000) {
    let cut = rest.lastIndexOf('\n', 2000)
    if (cut <= 0) cut = 2000
    parts.push(rest.slice(0, cut))
    rest = `\u200B\n${rest.slice(cut).replace(/^\n/, '')}`
  }
  if (rest) parts.push(rest)
  return parts
}

export async function postToolBreadcrumb({
  channel,
  tools,
  used,
}: {
  channel: Channel
  tools: Tool<any>[]
  used: Map<string, number>
}): Promise<void> {
  if (used.size === 0 || !channel.isSendable()) return
  const labelsMap = new Map(tools.map((t) => [t.definition.function.name, t.label]))
  const body = `-# ${used
    .entries()
    .map(([name, count]) => {
      const labelFn = labelsMap.get(name)
      if (!labelFn) throw new Error(`Tool used but not in tools list: ${name}`)
      return labelFn(count)
    })
    .toArray()
    .join(' · ')}`
  used.clear()
  await channel.send(body).catch(() => {})
}

export async function fetchAllMessages(
  channel: Channel,
  after?: string | null,
): Promise<Message[]> {
  if (!channel.isTextBased()) return []
  const messages: Message[] = []

  if (after) {
    let cursor = after
    while (true) {
      const batch: Collection<string, Message> = await channel.messages.fetch({
        limit: 100,
        after: cursor,
      })
      if (batch.size === 0) break
      batch.forEach((m) => messages.push(m))
      cursor = batch.first()!.id // API returns newest-first, so first is the newest
      if (batch.size < 100) break
    }
    return messages
  }

  let before: string | undefined
  while (true) {
    const batch: Collection<string, Message> = await channel.messages.fetch({
      limit: 100,
      before,
    })
    if (batch.size === 0) break
    batch.forEach((m) => messages.push(m))
    before = batch.last()!.id
    if (batch.size < 100) break
  }
  return messages
}

// Every human member of a guild. Needs the GuildMembers privileged intent.
export async function fetchNonBotUsers(guild: Guild): Promise<GuildMember[]> {
  const members = await guild.members.fetch()
  return [...members.values()].filter((m) => !m.user.bot)
}

// every thread in a guild, active and archived, so a backfill misses nothing.
export async function getAllThreads(guild: Guild): Promise<AnyThreadChannel[]> {
  const byId = new Map<string, AnyThreadChannel>()
  const add = (thread: AnyThreadChannel) => byId.set(thread.id, thread)

  const jobs = []
  jobs.push(guild.channels.fetchActiveThreads().then((res) => res.threads.forEach(add)))

  const fetchArchivedThreads = async (
    type: 'public' | 'private',
    channel: NewsChannel | TextChannel | ForumChannel | MediaChannel,
  ) => {
    let before: number | undefined
    let hasMore = true
    while (hasMore) {
      const page = await channel.threads
        .fetchArchived({ type, before, limit: 100, fetchAll: true })
        .catch(() => null)
      if (!page) break

      page.threads.forEach(add)
      const oldest = page.threads.last()
      before = oldest?.archiveTimestamp ?? undefined
      hasMore = page.hasMore && !!oldest
    }
  }

  const channels = await guild.channels.fetch()
  for (const channel of channels.values()) {
    if (!channel || !('threads' in channel)) continue
    jobs.push(fetchArchivedThreads('public', channel))
    jobs.push(fetchArchivedThreads('private', channel))
  }

  await Promise.all(jobs)

  return [...byId.values()]
}

import {
  Collection,
  type AnyThreadChannel,
  type Channel,
  type Client,
  type Guild,
  type Message
} from 'discord.js'
import { listEphemeralChannelIds } from '../repositories/channelSettings'
import { deleteMessages, getLatestMessage } from '../repositories/messages'
import { log } from '../logger'

export async function fetchAllMessages(
  channel: Channel,
  after?: string | null
): Promise<Message[]> {
  if (!channel.isTextBased()) return []
  const messages: Message[] = []

  if (after) {
    let cursor = after
    while (true) {
      const batch: Collection<string, Message> = await channel.messages.fetch({
        limit: 100,
        after: cursor
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
      before
    })
    if (batch.size === 0) break
    batch.forEach((m) => messages.push(m))
    before = batch.last()!.id
    if (batch.size < 100) break
  }
  return messages
}

export async function sweepEphemeral(client: Client): Promise<void> {
  for (const channelId of await listEphemeralChannelIds()) {
    const last = await getLatestMessage(channelId)
    if (!last) continue
    if (Date.now() - last.sent_at.getTime() < 10 * 60_000) continue
    const channel = await client.channels.fetch(channelId).catch(() => null)
    if (!channel || !channel.isTextBased() || channel.isDMBased()) continue
    const deleted = await channel.bulkDelete(100, true)
    if (deleted.size > 0) {
      await deleteMessages([...deleted.keys()])
      log.info({ channelId, cleared: deleted.size }, 'swept ephemeral channel')
    }
  }
}

// every thread in a guild, active and archived, so a backfill misses nothing.
export async function getAllThreads(guild: Guild): Promise<AnyThreadChannel[]> {
  const byId = new Map<string, AnyThreadChannel>()
  const add = (thread: AnyThreadChannel) => byId.set(thread.id, thread)

  const active = await guild.channels.fetchActiveThreads()
  active.threads.forEach(add)

  const channels = await guild.channels.fetch()
  for (const channel of channels.values()) {
    if (!channel || !('threads' in channel)) continue

    for (const type of ['public', 'private'] as const) {
      let before: number | undefined
      let hasMore = true
      while (hasMore) {
        const page = await channel.threads
          .fetchArchived({ type, before, limit: 100, fetchAll: type === 'private' })
          .catch(() => null)
        if (!page) break

        page.threads.forEach(add)
        const oldest = page.threads.last()
        before = oldest?.archiveTimestamp ?? undefined
        hasMore = page.hasMore && !!oldest
      }
    }
  }

  return [...byId.values()]
}

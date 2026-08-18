import { type AnyThreadChannel, type Guild } from 'discord.js'

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

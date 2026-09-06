import { sql } from 'kysely'
import { db } from '../db'

// The tiered memory block for a channel: global + parent channel + this channel/thread, labelled.
export async function resolveMemory(
  channelId: string,
  parentChannelId: string | null,
): Promise<string> {
  const ids = [channelId, parentChannelId, 'global'].filter((id): id is string => id !== null)
  const rows = await db.selectFrom('memory').selectAll().where('channel_id', 'in', ids).execute()

  const global = rows.find((r) => r.channel_id === 'global')
  const parent = parentChannelId ? rows.find((r) => r.channel_id === parentChannelId) : undefined
  const own = rows.find((r) => r.channel_id === channelId && r.channel_id !== 'global')

  return [
    global?.content.trim() && `# Global memory\n${global.content.trim()}`,
    parent?.content.trim() && `# Channel memory\n${parent.content.trim()}`,
    own?.content.trim() &&
      `# ${parentChannelId ? 'Thread' : 'Channel'} memory\n${own.content.trim()}`,
  ]
    .filter(Boolean)
    .join('\n\n')
}

export async function updateMemory({
  channelId,
  memory,
}: {
  channelId: string
  memory: string
}): Promise<void> {
  // memory.channel_id references channel_settings, so ensure a settings row exists first.
  await db
    .insertInto('channel_settings')
    .values({ channel_id: channelId })
    .onConflict((oc) => oc.doNothing())
    .execute()
  await db
    .insertInto('memory')
    .values({ channel_id: channelId, content: memory, as_of: sql`now()` })
    .onConflict((oc) =>
      oc
        .column('channel_id')
        .doUpdateSet({ content: memory, as_of: sql`now()`, updated_at: sql`now()` }),
    )
    .execute()
}

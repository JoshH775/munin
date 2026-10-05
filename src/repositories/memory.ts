import { sql } from 'kysely'
import type { Dayjs } from 'dayjs'
import { db } from '../db'

// The tiered memory block for a channel: global + parent channel + this channel/thread, labelled.
export async function resolveMemory(
  channelId: string,
  parentChannelId: string | null,
): Promise<string> {
  const ids = [channelId, parentChannelId].filter((id): id is string => id !== null)
  const memories = await db.selectFrom('memory').selectAll().where('channel_id', 'in', ids).execute()
  const global = await db.selectFrom('global_memory').selectAll().executeTakeFirst()

  const parent = parentChannelId ? memories.find((m) => m.channel_id === parentChannelId) : undefined
  const own = memories.find((m) => m.channel_id === channelId)

  // fix the rendering
  return [
    global?.content.trim() && `# Global memory\n${global.content.trim()}`,
    parent?.content.trim() && `# Channel memory\n${parent.content.trim()}`,
    own?.content.trim() &&
      `# ${parentChannelId ? 'Thread' : 'Channel'} memory\n${own.content.trim()}`,
  ]
    .filter(Boolean)
    .join('\n\n')
}

export async function getMemory(channelId: string): Promise<string | null> {
  const row = await db
    .selectFrom('memory')
    .select('content')
    .where('channel_id', '=', channelId)
    .executeTakeFirst()
  return row?.content ?? null
}

// One sweep's result as one transaction: the watermark, and the doc when it changed.
export async function writeMemorySweep(
  channelId: string,
  sweptTo: Dayjs,
  { memory, description }: { memory: string | null; description: string | null },
): Promise<void> {
  await db.transaction().execute(async (trx) => {
    // memory references the settings row, so it goes in first
    await trx
      .insertInto('channel_settings')
      .values({ channel_id: channelId, last_memory_sweep_at: sweptTo })
      .onConflict((oc) => oc.column('channel_id').doUpdateSet({ last_memory_sweep_at: sweptTo }))
      .execute()
    if (!memory) return
    await trx
      .insertInto('memory')
      .values({ channel_id: channelId, content: memory, description })
      .onConflict((oc) =>
        oc.column('channel_id').doUpdateSet({ content: memory, description, updated_at: sql`now()` }),
      )
      .execute()
  })
}

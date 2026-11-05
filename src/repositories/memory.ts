import { db } from '../db'
import type { Dayjs } from 'dayjs'
import { dayjs } from '../time'

// The tiered memory block for a channel: global + parent channel + this channel/thread, labelled.
export async function resolveMemory(
  channelId: string,
  parentChannelId: string | null,
): Promise<string> {
  const ids = [channelId, parentChannelId].filter((id): id is string => id !== null)
  const memories = await db.selectFrom('semantic_memory').selectAll().where('channel_id', 'in', ids).execute()
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

export async function getMemory(channelId: string) {
  const row = await db
    .selectFrom('semantic_memory')
    .select(['content', 'description'])
    .where('channel_id', '=', channelId)
    .executeTakeFirst()
  return row ? { content: row.content, description: row.description } : null
}

export async function writeEncoding(params: {
  channelId: string,
  semantic: { content: string, description: string } | null,
  lastEncodedAt: Dayjs,
}
) {
  const { channelId, semantic, lastEncodedAt } = params
  await db.transaction().execute(async (trx) => {
    // first: semantic_memory references channel_settings, which may have no row yet
    await trx.insertInto('channel_settings').values({ channel_id: channelId, last_encoded_at: lastEncodedAt }).onConflict((oc) => oc.column('channel_id').doUpdateSet({ last_encoded_at: lastEncodedAt })).execute()

    if (semantic) {
      await trx
        .insertInto('semantic_memory')
        .values({ channel_id: channelId, content: semantic.content, description: semantic.description })
        .onConflict((oc) => oc.column('channel_id').doUpdateSet({ content: semantic.content, description: semantic.description, updated_at: dayjs() }))
        .execute()
    }
  })
}
    

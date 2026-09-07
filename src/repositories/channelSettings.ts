import { sql } from 'kysely'
import { db } from '../db'

export type ChannelSettings = {
  enabled: boolean
  ephemeral: boolean
}

export async function resolveSettings(
  channelId: string,
  parentChannelId: string | null,
): Promise<ChannelSettings> {
  const ids = [channelId, parentChannelId].filter((id): id is string => id !== null)
  const rows = await db
    .selectFrom('channel_settings')
    .selectAll()
    .where('channel_id', 'in', ids)
    .execute()

  const own = rows.find((r) => r.channel_id === channelId)
  const parent = parentChannelId ? rows.find((r) => r.channel_id === parentChannelId) : undefined

  return {
    enabled: !own?.muted,
    ephemeral: !!(own?.ephemeral || parent?.ephemeral),
  }
}

// set (not toggle) the mute for a channel. /mute passes true, /unmute passes false.
export async function setMuted(channelId: string, muted: boolean): Promise<void> {
  await db
    .insertInto('channel_settings')
    .values({ channel_id: channelId, muted })
    .onConflict((oc) => oc.column('channel_id').doUpdateSet({ muted, updated_at: sql`now()` }))
    .execute()
}

// remove settings rows for deleted channels/threads.
export async function deleteSettings(channelIds: string[]): Promise<void> {
  if (channelIds.length === 0) return
  await db.deleteFrom('channel_settings').where('channel_id', 'in', channelIds).execute()
}

// toggles the ephemeral flag for a channel. returns true if now ephemeral, false if not.
export async function toggleEphemeral(channelId: string): Promise<boolean> {
  const existing = await db
    .selectFrom('channel_settings')
    .select('ephemeral')
    .where('channel_id', '=', channelId)
    .executeTakeFirst()
  const next = !existing?.ephemeral
  await db
    .insertInto('channel_settings')
    .values({ channel_id: channelId, ephemeral: next })
    .onConflict((oc) =>
      oc.column('channel_id').doUpdateSet({ ephemeral: next, updated_at: sql`now()` }),
    )
    .execute()
  return next
}

// channel ids currently flagged ephemeral (the idle sweep's work list).
export async function listEphemeralChannelIds(): Promise<string[]> {
  const rows = await db
    .selectFrom('channel_settings')
    .select('channel_id')
    .where('ephemeral', '=', true)
    .execute()
  return rows.map((r) => r.channel_id)
}

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import Anthropic from '@anthropic-ai/sdk'
import { sql } from 'kysely'
import { db } from '../db'
import { type Effort } from '../ai'

const globalPersona = readFileSync(
  fileURLToPath(new URL('../../system.md', import.meta.url)),
  'utf8',
).trim()

export type ChannelSettings = {
  channelId: string
  parentChannelId: string | null
  model: Anthropic.Model
  effort: Effort
  persona: string
  memory: string
  parentMemoryChannelId: string
  enabled: boolean
  ephemeral: boolean
}

export async function resolveSettings(
  channelId: string,
  parentChannelId: string | null,
): Promise<ChannelSettings> {
  const ids = [channelId, parentChannelId, 'global'].filter((id): id is string => id !== null)
  const rows = await db
    .selectFrom('channel_settings')
    .selectAll()
    .where('channel_id', 'in', ids)
    .execute()

  const global = rows.find((r) => r.channel_id === 'global')
  if (!global) {
    throw new Error('Global settings row not found')
  }
  if (global.model == null || global.effort == null) {
    throw new Error('Global row is missing default model/effort')
  }
  const parent = parentChannelId ? rows.find((r) => r.channel_id === parentChannelId) : undefined
  const own = rows.find((r) => r.channel_id === channelId && r.channel_id !== 'global')

  return {
    channelId,
    parentChannelId,
    model: own?.model ?? parent?.model ?? global.model,
    effort: own?.effort ?? parent?.effort ?? global.effort,
    persona: [globalPersona, parent?.system_prompt, own?.system_prompt]
      .filter(Boolean)
      .join('\n\n'),
    memory: [
      global.memory.trim() && `# Global memory\n${global.memory.trim()}`,
      parent?.memory.trim() && `# Channel memory\n${parent.memory.trim()}`,
      own?.memory.trim() &&
        `# ${parentChannelId ? 'Thread' : 'Channel'} memory\n${own.memory.trim()}`,
    ]
      .filter(Boolean)
      .join('\n\n'),
    parentMemoryChannelId: parentChannelId ?? 'global',
    enabled: !(own?.disabled_at || parent?.disabled_at || global.disabled_at),
    ephemeral: !!(own?.ephemeral || parent?.ephemeral),
  }
}

export async function updateMemory({
  channelId,
  memory,
}: {
  channelId: string
  memory: string
}): Promise<void> {
  await db
    .insertInto('channel_settings')
    .values({ channel_id: channelId, memory })
    .onConflict((oc) => oc.column('channel_id').doUpdateSet({ memory, updated_at: sql`now()` }))
    .execute()
}

export async function updateConfig({
  channelId,
  ...patch
}: {
  channelId: string
  model?: Anthropic.Model | null
  effort?: Effort | null
  system_prompt?: string | null
}): Promise<void> {
  await db
    .insertInto('channel_settings')
    .values({ channel_id: channelId, ...patch })
    .onConflict((oc) => oc.column('channel_id').doUpdateSet({ ...patch, updated_at: sql`now()` }))
    .execute()
}

// remove settings rows for deleted channels/threads. never touches the reserved global row.
export async function deleteSettings(channelIds: string[]): Promise<void> {
  const ids = channelIds.filter((id) => id !== 'global')
  if (ids.length === 0) return
  await db.deleteFrom('channel_settings').where('channel_id', 'in', ids).execute()
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

// toggles the mute for one channel (or 'global'). returns true if now muted, false if now unmuted.
export async function toggleChannelMute(channelId: string): Promise<boolean> {
  const existing = await db
    .selectFrom('channel_settings')
    .select('disabled_at')
    .where('channel_id', '=', channelId)
    .executeTakeFirst()
  const muting = !existing?.disabled_at // no row or null = currently on, so we're muting
  await db
    .insertInto('channel_settings')
    .values({ channel_id: channelId, disabled_at: muting ? sql`now()` : null })
    .onConflict((oc) =>
      oc.column('channel_id').doUpdateSet({
        disabled_at: muting ? sql`now()` : null,
        updated_at: sql`now()`,
      }),
    )
    .execute()
  return muting
}

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import Anthropic from '@anthropic-ai/sdk'
import { sql } from 'kysely'
import { db } from '../db'
import { type Effort } from '../ai'

const globalPersona = readFileSync(
  fileURLToPath(new URL('../../system.md', import.meta.url)),
  'utf8'
).trim()

export type ChannelSettings = {
  channelId: string
  parentChannelId: string | null
  model: Anthropic.Model
  effort: Effort
  persona: string
  memory: string
  parentMemoryChannelId: string
}

export async function resolveSettings(
  channelId: string,
  parentChannelId: string | null
): Promise<ChannelSettings> {
  const ids = [channelId, parentChannelId, 'global'].filter(
    (id): id is string => id !== null
  )
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
  const parent = parentChannelId
    ? rows.find((r) => r.channel_id === parentChannelId)
    : undefined
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
    .onConflict((oc) =>
      oc.column('channel_id').doUpdateSet({ memory, updated_at: sql`now()` })
    )
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
    .onConflict((oc) =>
      oc.column('channel_id').doUpdateSet({ ...patch, updated_at: sql`now()` })
    )
    .execute()
}

// remove settings rows for deleted channels/threads. never touches the reserved global row.
export async function deleteSettings(channelIds: string[]): Promise<void> {
  const ids = channelIds.filter((id) => id !== 'global')
  if (ids.length === 0) return
  await db.deleteFrom('channel_settings').where('channel_id', 'in', ids).execute()
}

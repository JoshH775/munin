import Anthropic from '@anthropic-ai/sdk'
import { sql } from 'kysely'
import { db } from '../db'
import { models } from '../ai/models'

export type AgentSettings = {
  channelId: string
  memory?: string
  model: Anthropic.Model
  persona: string
  globalMemory: string
}

export async function resolveSettings(
  channelId: string
): Promise<AgentSettings> {
  let settings = await db
    .selectFrom('agent_settings')
    .selectAll()
    .where('channel_id', 'in', [channelId, 'global'])
    .execute()

  const global = settings.find((s) => s.channel_id === 'global')
  const channel = settings.find((s) => s.channel_id !== 'global')

  if (!global) {
    throw new Error('Global settings row not found')
  }

  return {
    channelId,
    memory: channel?.memory,
    model: channel?.model ?? global.model ?? models.sonnet5,
    persona: [global.system_prompt, channel?.system_prompt]
      .filter(Boolean)
      .join('\n\n'),
    globalMemory: global.memory
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
    .insertInto('agent_settings')
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
  system_prompt?: string | null
}): Promise<void> {
  await db
    .insertInto('agent_settings')
    .values({ channel_id: channelId, ...patch })
    .onConflict((oc) =>
      oc.column('channel_id').doUpdateSet({ ...patch, updated_at: sql`now()` })
    )
    .execute()
}

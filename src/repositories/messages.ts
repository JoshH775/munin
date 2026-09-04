import type Anthropic from '@anthropic-ai/sdk'
import type { Insertable, Selectable } from 'kysely'
import { db } from '../db/index'
import type { Messages } from '../db/types'

export async function insertMessage(message: Insertable<Messages>): Promise<void> {
  if (!message.content.trim()) return // skip contentless messages (images, embeds, system events)
  await db
    .insertInto('messages')
    .values(message)
    .onConflict((oc) => oc.column('id').doNothing()) // idempotent on the snowflake id
    .execute()
}

export async function deleteMessages(ids: string[]): Promise<void> {
  if (ids.length === 0) return
  await db.deleteFrom('messages').where('id', 'in', ids).execute()
}

export async function deleteChannelMessages(channelId: string): Promise<void> {
  await db.deleteFrom('messages').where('channel_id', '=', channelId).execute()
}

export async function getLatestMessage(
  channelId: string,
): Promise<{ id: string; sent_at: Date } | null> {
  const row = await db
    .selectFrom('messages')
    .select(['id', 'sent_at'])
    .where('channel_id', '=', channelId)
    .orderBy('sent_at', 'desc')
    .limit(1)
    .executeTakeFirst()
  return row ?? null
}

export async function getConversation({
  channelId,
}: {
  channelId: string
}): Promise<Selectable<Messages>[]> {
  return db
    .selectFrom('messages')
    .selectAll()
    .where('channel_id', '=', channelId)
    .orderBy('sent_at', 'asc')
    .execute()
}

export async function getMessagesSince({
  channelId,
  since,
}: {
  channelId: string
  since: Date
}): Promise<Selectable<Messages>[]> {
  return db
    .selectFrom('messages')
    .selectAll()
    .where('channel_id', '=', channelId)
    .where('sent_at', '>=', since)
    .orderBy('sent_at', 'asc')
    .execute()
}

export function toChatTranscript(
  messages: Selectable<Messages>[],
  botUserId: string,
): Anthropic.MessageParam[] {
  const params = messages
    .filter((m) => m.content.trim()) // drop contentless messages (attachments, embeds, system events)
    // keep user messages and munin's real replies; drop its own status lines. munin's replies never
    // start with '-# ' (its tool summaries do); the oldest tool rows are bare 'Tool used:'.
    .filter(
      (m) =>
        m.user_id !== botUserId ||
        (!m.content.startsWith('-# ') && !m.content.startsWith('Tool used:')),
    )
    .map((m): Anthropic.MessageParam => ({
      role: m.user_id === botUserId ? 'assistant' : 'user',
      content: m.content,
    }))
  const firstUser = params.findIndex((p) => p.role === 'user')
  const transcript = firstUser === -1 ? [] : params.slice(firstUser)
  const last = transcript.at(-1)
  if (last && typeof last.content === 'string') {
    last.content = [{ type: 'text', text: last.content, cache_control: { type: 'ephemeral' } }]
  }
  return transcript
}

export async function searchMessages(opts: {
  channelId?: string
  since?: string
  query?: string
  limit?: number
}): Promise<Selectable<Messages>[]> {
  const { channelId, since, query, limit } = opts
  let q = db.selectFrom('messages').selectAll()
  if (channelId) q = q.where('channel_id', '=', channelId)
  if (since) q = q.where('sent_at', '>=', new Date(since))
  if (query) q = q.where('content', 'ilike', `%${query}%`)
  if (limit) q = q.limit(limit)
  return q.orderBy('sent_at', 'desc').execute()
}
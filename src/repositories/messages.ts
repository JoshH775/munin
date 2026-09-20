import type { Insertable, Selectable } from 'kysely'
import type { Dayjs } from 'dayjs'
import { db } from '../db/index'
import type { Messages } from '../db/types'
import type OpenAI from 'openai'

// Resolves true only when a row was actually written.
export async function insertMessage(message: Insertable<Messages>): Promise<boolean> {
  if (!message.content.trim()) return false // skip contentless messages (images, embeds, system events)
  const result = await db
    .insertInto('messages')
    .values(message)
    .onConflict((oc) => oc.column('id').doNothing()) // idempotent on the snowflake id
    .executeTakeFirst()
  return result.numInsertedOrUpdatedRows === 1n
}

export async function updateMessageContent(id: string, content: string): Promise<void> {
  await db.updateTable('messages').set({ content }).where('id', '=', id).execute()
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
): Promise<{ id: string; sent_at: Dayjs } | null> {
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
  since: Dayjs
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
): OpenAI.ChatCompletionMessageParam[] {
  const transcript = messages
    // 'tool'/'thinking' are munin's status lines; contentless rows are attachments and embeds
    .filter((m) => m.kind === 'chat' && m.content.trim())
    .map((m): OpenAI.ChatCompletionMessageParam => ({
      role: m.user_id === botUserId ? 'assistant' : 'user',
      content: m.content,
    }))

  return transcript
}

export async function searchMessages(opts: {
  channelId?: string
  since?: Dayjs
  query?: string
  limit?: number
}): Promise<Selectable<Messages>[]> {
  const { channelId, since, query, limit } = opts
  let q = db.selectFrom('messages').selectAll().where('kind', '=', 'chat')
  if (channelId) q = q.where('channel_id', '=', channelId)
  if (since) q = q.where('sent_at', '>=', since)
  if (query) q = q.where('content', 'ilike', `%${query}%`)
  if (limit) q = q.limit(limit)
  return q.orderBy('sent_at', 'desc').execute()
}

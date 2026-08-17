import type Anthropic from '@anthropic-ai/sdk'
import type { Insertable, Selectable } from 'kysely'
import { db } from '../db/index'
import type { Messages } from '../db/types'

export async function insertMessage(message: Insertable<Messages>): Promise<void> {
  await db
    .insertInto('messages')
    .values(message)
    .onConflict((oc) => oc.column('id').doNothing()) // idempotent on the snowflake id
    .execute()
}


export async function getRecentMessages({
  channelId,
  threadId,
  limit = 50,
}: {
  channelId: string
  threadId: string | null
  limit?: number
}): Promise<Selectable<Messages>[]> {
  let query = db.selectFrom('messages').selectAll().where('channel_id', '=', channelId)
  query = threadId === null ? query.where('thread_id', 'is', null) : query.where('thread_id', '=', threadId)
  const rows = await query.orderBy('created_at', 'desc').limit(limit).execute()
  return rows.reverse() // oldest-first for prompt building
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
    .where('created_at', '>=', since)
    .orderBy('created_at', 'asc')
    .execute()
}


export function toChatTranscript(
  messages: Selectable<Messages>[]
): Anthropic.MessageParam[] {
  const botUserId = process.env.DISCORD_BOT_ID
  if (!botUserId) {
    throw new Error('DISCORD_BOT_ID not set in env')
  }
  const params = messages.map(
    (m): Anthropic.MessageParam => ({
      role: m.user_id === botUserId ? 'assistant' : 'user',
      content: m.content,
    })
  )
  const firstUser = params.findIndex((p) => p.role === 'user')
  return firstUser === -1 ? [] : params.slice(firstUser)
}
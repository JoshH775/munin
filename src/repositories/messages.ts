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

export async function getRecentMessages(channelId: string, limit = 50): Promise<Selectable<Messages>[]> {
  const rows = await db
    .selectFrom('messages')
    .selectAll()
    .where('channel_id', '=', channelId)
    .orderBy('created_at', 'desc')
    .limit(limit)
    .execute()
  return rows.reverse() // oldest-first for prompt building
}

export async function getMessagesSince(channelId: string, since: Date): Promise<Selectable<Messages>[]> {
  return db
    .selectFrom('messages')
    .selectAll()
    .where('channel_id', '=', channelId)
    .where('created_at', '>=', since)
    .orderBy('created_at', 'asc')
    .execute()
}

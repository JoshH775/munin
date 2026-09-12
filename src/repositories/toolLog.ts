import type { Insertable, Selectable } from 'kysely'
import type { Dayjs } from 'dayjs'
import { db } from '../db/index'
import type { ToolLog } from '../db/types'

export async function insertToolLog(row: Insertable<ToolLog>): Promise<void> {
  await db.insertInto('tool_log').values(row).execute()
}

export async function searchToolLog(opts: {
  channelId?: string
  tool?: string
  errorsOnly?: boolean
  since?: Dayjs
  limit: number
}): Promise<Selectable<ToolLog>[]> {
  const { channelId, tool, errorsOnly, since, limit } = opts
  let q = db.selectFrom('tool_log').selectAll()
  if (channelId) q = q.where('channel_id', '=', channelId)
  if (tool) q = q.where('tool', '=', tool)
  if (errorsOnly) q = q.where('error', 'is not', null)
  if (since) q = q.where('created_at', '>=', since)
  return q.orderBy('created_at', 'desc').limit(limit).execute()
}

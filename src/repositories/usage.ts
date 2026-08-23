import type { Insertable } from 'kysely'
import { db } from '../db/index'
import type { Usage } from '../db/types'

export async function insertUsage(usage: Insertable<Usage>): Promise<void> {
  await db.insertInto('usage').values(usage).execute()
}

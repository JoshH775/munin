import type { Selectable } from 'kysely'
import type { AppSettings } from '../db/types'
import type { Effort } from '../ai'
import { db } from '../db'

export async function getAppSettings(): Promise<Selectable<AppSettings>> {
  return db.selectFrom('app_settings').selectAll().executeTakeFirstOrThrow()
}

// App-wide defaults live in the singleton row, so no where clause is needed.
export async function updateAppSettings(patch: {
  chat_model?: string
  effort?: Effort
}): Promise<void> {
  await db.updateTable('app_settings').set(patch).execute()
}

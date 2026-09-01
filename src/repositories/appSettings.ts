import type { Selectable } from 'kysely'
import type { AppSettings } from '../db/types'
import { db } from '../db'

export async function getAppSettings(): Promise<Selectable<AppSettings>> {
  return db.selectFrom('app_settings').selectAll().executeTakeFirstOrThrow()
}

export async function setReminderChannel(channelId: string): Promise<void> {
  await db.updateTable('app_settings').set({ reminder_channel_id: channelId }).execute()
}

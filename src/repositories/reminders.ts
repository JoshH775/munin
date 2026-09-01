import type { Insertable, Selectable } from 'kysely'
import type { Reminders } from '../db/types'
import { db } from '../db'

export async function insertNewReminder(
  reminder: Insertable<Reminders>
): Promise<{ id: string }> {
  return db
    .insertInto('reminders')
    .values(reminder)
    .returning('id')
    .executeTakeFirstOrThrow()
}

// Pending reminders whose time has come, for the poller to deliver.
export async function getDueReminders(): Promise<Selectable<Reminders>[]> {
  return db
    .selectFrom('reminders')
    .selectAll()
    .where('status', '=', 'pending')
    .where('date', '<=', new Date())
    .execute()
}

export async function getPendingReminders(): Promise<Selectable<Reminders>[]> {
  return db
    .selectFrom('reminders')
    .selectAll()
    .where('status', '=', 'pending')
    .orderBy('date', 'asc')
    .execute()
}

export async function markReminderSent(id: string): Promise<void> {
  await db
    .updateTable('reminders')
    .set({ status: 'sent' })
    .where('id', '=', id)
    .execute()
}

// Set when the user clicks the acknowledgement button on a delivered reminder.
export async function markReminderReceived(id: string): Promise<void> {
  await db
    .updateTable('reminders')
    .set({ received: true })
    .where('id', '=', id)
    .execute()
}

// Soft-cancel: keep the row as 'cancelled' so it never fires. Returns rows changed
// (0 if the id is unknown or the reminder has already fired).
export async function cancelReminder(id: string): Promise<number> {
  const res = await db
    .updateTable('reminders')
    .set({ status: 'cancelled' })
    .where('id', '=', id)
    .where('status', '=', 'pending')
    .executeTakeFirst()
  return Number(res?.numUpdatedRows ?? 0)
}

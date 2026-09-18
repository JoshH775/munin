import { z } from 'zod'
import { makeTool } from '../makeTool'
import { insertNewReminder, deleteReminder, getPendingReminders } from '../../repositories/reminders'
import { parseTime } from '../../time'
import type { Client } from 'discord.js'

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

export function createReminderTool(client: Client, setById: string) {
  return makeTool({
    name: 'create_reminder',
    label: (n) => `Set ${plural(n, 'reminder')}`,
    description:
      'Schedule a one-off reminder to post at a future time. Give the time as London local time in ' +
      'ISO 8601 form with no zone suffix (e.g. 2026-09-01T14:30); the current London time is in your ' +
      'context, so work forward from that. It fires within about a minute of the given time. Pass the channel ' +
      'to post it in: the current channel id is in your context, or target a dedicated reminders channel ' +
      "you find via channel_tree or recall from your memory. Returns the reminder's id, which delete_reminder needs to cancel it.",
    inputSchema: z.object({
      date: z.iso
        .datetime({ local: true })
        .describe('When to fire, as London local time in ISO 8601 form with no zone suffix.'),
      content: z.string().max(1800).describe('The reminder message to post.'),
      channelId: z.string().describe('The channel or thread to post the reminder in.'),
    }),
    run: async ({ content, date, channelId }) => {
      const channel = await client.channels.fetch(channelId).catch(() => null)
      if (!channel || !channel.isTextBased() || channel.isDMBased()) {
        throw new Error(
          'No text channel or thread with that id. Call channel_tree for the list of ids.',
        )
      }
      const when = parseTime(date)
      const { id } = await insertNewReminder({
        content,
        date: when,
        channel_id: channelId,
        target: setById,
      })
      return `Reminder set for ${when.tz().format('dddd D MMMM HH:mm')} in <#${channelId}> (id ${id}).`
    },
  })
}

export function deleteReminderTool() {
  return makeTool({
    name: 'delete_reminder',
    label: (n) => `Cancelled ${plural(n, 'reminder')}`,
    description:
      'Delete a pending reminder by its id so it never fires. The id is the one create_reminder ' +
      'returned. Does nothing if the reminder has already fired or the id is unknown.',
    inputSchema: z.object({
      id: z.uuid().describe('The id of the reminder to delete.'),
    }),
    run: async ({ id }) => {
      const deleted = await deleteReminder(id)
      return deleted > 0 ? `Deleted reminder ${id}.` : `No pending reminder with id ${id}.`
    },
  })
}

export function listRemindersTool() {
  return makeTool({
    name: 'list_reminders',
    label: () => 'Checked reminders',
    description:
      'List every pending reminder with its id, time, channel, and content, so you can tell the ' +
      'user what is scheduled or find the id to cancel one with delete_reminder.',
    inputSchema: z.object({}),
    run: async () => {
      const reminders = await getPendingReminders()
      if (reminders.length === 0) return 'No pending reminders.'
      return reminders
        .map(
          (r) =>
            `${r.id} — ${r.date.tz().format('ddd D MMM YYYY HH:mm')} — ${r.channel_id ? `<#${r.channel_id}>` : 'default channel'} — ${r.content}`,
        )
        .join('\n')
    },
  })
}

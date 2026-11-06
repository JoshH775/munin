import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Guild,
  TextChannel,
  type Client,
  type TextThreadChannel,
} from 'discord.js'
import { listEphemeralChannelIds } from './repositories/channelSettings'
import { deleteMessages, getChannelsToEncode, getUnencodedMessages } from './repositories/messages'
import { getDueReminders, markReminderSent } from './repositories/reminders'
import { log } from './logger'
import { dayjs } from './time'
import type { Dayjs } from 'dayjs'
import { encodeChannel } from './ai/encode'

export async function sweepEphemeral(client: Client): Promise<void> {
  for (const channelId of await listEphemeralChannelIds()) {
    
    // a chat still waiting on its encode keeps until the next night, or its notes would miss it
    const unencoded = await getUnencodedMessages(channelId)
    if (unencoded.length) continue

    const channel = await client.channels.fetch(channelId)
    if (!channel || !channel.isTextBased() || channel.isDMBased()) continue

    let cleared = 0

    // bulkDelete takes 100 at most, so keep going until a batch comes back short
    while (true) {
      const deleted = await channel.bulkDelete(100, true)
      await deleteMessages([...deleted.keys()])
      cleared += deleted.size
      if (deleted.size < 100) break
    }
    if (cleared) log.info({ channelId, cleared }, 'Swept ephemeral channel')
  }
}

export async function dispatchReminders(client: Client): Promise<void> {
  const due = await getDueReminders()
  if (due.length === 0) return

  for (const reminder of due) {
    const targetChannelId = reminder.channel_id
    if (!targetChannelId) {
      log.warn({ reminderId: reminder.id }, 'Reminder has no channel')
      continue
    }
    const channel = await client.channels.fetch(targetChannelId)
    if (!channel || !channel.isTextBased() || channel.isDMBased()) {
      log.warn({ reminderId: reminder.id, targetChannelId }, 'Reminder channel unavailable')
      continue
    }
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`reminder_ack:${reminder.id}`)
        .setLabel('Got it')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`reminder_snooze_5min:${reminder.id}`)
        .setLabel('Snooze 5 min')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`reminder_snooze_1hr:${reminder.id}`)
        .setLabel('Snooze 1 hour')
        .setStyle(ButtonStyle.Secondary),
    )
    try {
      // Flat text, not an embed: push notifications show `content` and would otherwise be blank.
      await channel.send({
        content: `⏰ **Reminder**\n${reminder.content}${reminder.target ? `\n<@${reminder.target}>` : ''}`,
        components: [row],
      })
      await markReminderSent(reminder.id)
      log.info({ reminderId: reminder.id }, 'Reminder delivered')
    } catch (err) {
      // Leave it pending so the next poll retries; don't mark sent on failure.
      log.error({ err, reminderId: reminder.id }, 'Reminder delivery failed')
    }
  }
}

// channels whose sweep failed, and when to try again; the watermark stays put so nothing is lost
const sweepRetryAfter = new Map<string, Dayjs>()

export async function sweepMemoryJob(client: Client, guild: Guild): Promise<void> {
  // the cache holds channels and threads, archived ones included, kept current by gateway events
  const channels = [...guild.channels.cache.values()].filter(
    (c): c is TextChannel | TextThreadChannel => c.isTextBased() && !c.isDMBased(),
  )

  const ready = channels.filter((c) => !sweepRetryAfter.get(c.id)?.isAfter(dayjs())) // failed recently, backing off
  const due = await getChannelsToEncode(ready.map((c) => c.id))
  const targets = ready.filter((c) => due.includes(c.id))

  let remaining = targets.length // encodes still to finish this run, for the log
  for (let i = 0; i < targets.length; i += 5) {
    await Promise.all(
      targets.slice(i, i + 5).map(async (c) => {
        try {
          await encodeChannel(c, client)
          sweepRetryAfter.delete(c.id)
          log.info({ channelId: c.id, channelName: c.name, remaining: --remaining }, 'Channel encoded')
        } catch (err) {
          remaining--
          sweepRetryAfter.set(c.id, dayjs().add(1, 'hour'))
          log.error(
            { err, channelId: c.id, channelName: c.name },
            'Encoding failed, retrying in an hour',
          )
        }
      }),
    )
  }
}

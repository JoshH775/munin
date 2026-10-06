import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Guild,
  TextChannel,
  type Client,
  type TextThreadChannel,
} from 'discord.js'
import { getLastMemorySweep, listEphemeralChannelIds } from './repositories/channelSettings'
import { deleteMessages, getConversation, getLatestMessage } from './repositories/messages'
import { getDueReminders, markReminderSent } from './repositories/reminders'
import { log } from './logger'
import { dayjs } from './time'
import type { Dayjs } from 'dayjs'
import { getMemory, writeMemorySweep } from './repositories/memory'
import { sweepMemory } from './ai'
import type { Selectable } from 'kysely'
import type { Messages } from './db/types'

export async function sweepEphemeral(client: Client): Promise<void> {
  for (const channelId of await listEphemeralChannelIds()) {
    const last = await getLatestMessage(channelId)
    if (!last) continue
    if (dayjs().diff(last.sent_at) < 45 * 60_000) continue
    const channel = await client.channels.fetch(channelId).catch(() => null)
    if (!channel || !channel.isTextBased() || channel.isDMBased()) continue
    const deleted = await channel.bulkDelete(100, true)
    if (deleted.size > 0) {
      await deleteMessages([...deleted.keys()])
      log.info({ channelId, cleared: deleted.size }, 'Swept ephemeral channel')
    }
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
    const channel = await client.channels.fetch(targetChannelId).catch(() => null)
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
  let remaining = 0 // channels not yet checked this run, for the log

  const sweepChannel = async (
    c: TextChannel | TextThreadChannel,
    conversation: Selectable<Messages>[],
  ) => {
    remaining--
    if (sweepRetryAfter.get(c.id)?.isAfter(dayjs())) return
    try {
      const doc = await getMemory(c.id)
      const sweepOutput = await sweepMemory({
        channelName: c.name,
        messages: conversation,
        doc: doc ?? '',
        muninId: client.user!.id,
        joshId: guild.ownerId,
      })

      log.info({ channelId: c.id, channelName: c.name, remaining }, 'Memory sweep completed')
      await writeMemorySweep(c.id, conversation[conversation.length - 1].sent_at, sweepOutput)
      sweepRetryAfter.delete(c.id)
    } catch (err) {
      sweepRetryAfter.set(c.id, dayjs().add(1, 'hour'))
      log.error(
        { err, channelId: c.id, channelName: c.name },
        'Memory sweep failed, retrying in an hour',
      )
    }
  }

  // the cache holds channels and threads, archived ones included, kept current by gateway events
  const channels = [...guild.channels.cache.values()].filter(
    (c): c is TextChannel | TextThreadChannel => c.isTextBased() && !c.isDMBased(),
  )

  const targets: {
    channel: TextChannel | TextThreadChannel
    conversation: Selectable<Messages>[]
  }[] = []
  for (const c of channels) {
    const [lastSweptAt, conversation] = await Promise.all([
      getLastMemorySweep(c.id),
      getConversation({ channelId: c.id }),
    ])
    const transcript = conversation
      .filter((m) => m.kind === 'chat' && m.content.trim())
      .filter((m) => lastSweptAt === null || m.sent_at.isAfter(lastSweptAt))
    const lastMessage = transcript.at(-1)

    if (!lastMessage) continue // nothing new to sweep
    if (!lastMessage.sent_at.isBefore(dayjs().subtract(30, 'minutes'))) continue // still active
    if (!transcript.some((m) => m.user_id === client.user?.id)) continue // munin hasn't spoken here
    targets.push({ channel: c, conversation: transcript })
  }

  remaining = targets.length
  for (let i = 0; i < targets.length; i += 5) {
    const batch = targets.slice(i, i + 5)
    await Promise.all(batch.map(({ channel, conversation }) => sweepChannel(channel, conversation)))
  }
}

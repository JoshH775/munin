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
import { getAllThreads } from './discord/utils'

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

export async function sweepMemoryJob(client: Client, guild: Guild, remaining: number | undefined = undefined): Promise<void> {
  const channels = (await guild.channels.fetch())
    .values()
    .filter((c): c is TextChannel => !!c && c.isTextBased() && !c.isDMBased())
  const threads = (await getAllThreads(guild)).filter((t): t is TextThreadChannel => !!t && t.isTextBased() && !t.isDMBased())

  for (const c of [...channels, ...threads]) {
    if (sweepRetryAfter.get(c.id)?.isAfter(dayjs())) continue
    try {
      const [doc, lastSweptAt] = await Promise.all([
      getMemory(c.id),
      getLastMemorySweep(c.id)
    ])

    const conversation = (await getConversation({ channelId: c.id }))
      .filter((m) => m.kind === 'chat' && m.content.trim())
      .filter((m) => lastSweptAt === null || m.sent_at.isAfter(lastSweptAt))
    const lastMessage = conversation[conversation.length - 1]

    if (conversation.length === 0) continue // nothing new to sweep
    if (!lastMessage.sent_at.isBefore(dayjs().subtract(30, 'minutes'))) continue // still active
    if (!conversation.some((m) => m.user_id === client.user?.id)) continue // munin hasn't spoken here

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
    }
  catch (err) {
    sweepRetryAfter.set(c.id, dayjs().add(1, 'hour'))
    log.error({ err, channelId: c.id, channelName: c.name }, 'Memory sweep failed, retrying in an hour')
  }
    
  }
}

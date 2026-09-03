import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Collection,
  EmbedBuilder,
  type AnyThreadChannel,
  type Channel,
  type Client,
  type Guild,
  type Message
} from 'discord.js'
import { listEphemeralChannelIds } from '../repositories/channelSettings'
import { deleteMessages, getLatestMessage, insertMessage } from '../repositories/messages'
import { getDueReminders, markReminderSent } from '../repositories/reminders'
import { getAppSettings } from '../repositories/appSettings'
import { toolLabels } from '../ai/toolLabels'
import { log } from '../logger'

// Post the pending tool calls as one subtext line ("-# Read 3 pages · Set 1 reminder"), tallying
// repeats. Empties `names`; anything without a label (not a real tool) is dropped.
export async function postPendingTools(channel: Channel, names: string[]): Promise<void> {
  const counts = new Map<string, number>()
  for (const name of names.splice(0)) {
    if (Object.hasOwn(toolLabels, name)) counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  if (counts.size === 0 || !channel.isSendable()) return
  const body =
    '-# ' +
    counts
      .entries()
      .map(([name, n]) => toolLabels[name](n))
      .toArray()
      .join(' · ')
  const sent = await channel.send(body).catch(() => null)
  if (!sent) return
  await insertMessage({
    channel_id: channel.id,
    content: body,
    user_id: channel.client.user!.id,
    user_name: 'munin',
    id: sent.id,
    sent_at: sent.createdAt,
    kind: 'tool'
  })
}

export async function fetchAllMessages(
  channel: Channel,
  after?: string | null
): Promise<Message[]> {
  if (!channel.isTextBased()) return []
  const messages: Message[] = []

  if (after) {
    let cursor = after
    while (true) {
      const batch: Collection<string, Message> = await channel.messages.fetch({
        limit: 100,
        after: cursor
      })
      if (batch.size === 0) break
      batch.forEach((m) => messages.push(m))
      cursor = batch.first()!.id // API returns newest-first, so first is the newest
      if (batch.size < 100) break
    }
    return messages
  }

  let before: string | undefined
  while (true) {
    const batch: Collection<string, Message> = await channel.messages.fetch({
      limit: 100,
      before
    })
    if (batch.size === 0) break
    batch.forEach((m) => messages.push(m))
    before = batch.last()!.id
    if (batch.size < 100) break
  }
  return messages
}

export async function sweepEphemeral(client: Client): Promise<void> {
  for (const channelId of await listEphemeralChannelIds()) {
    const last = await getLatestMessage(channelId)
    if (!last) continue
    if (Date.now() - last.sent_at.getTime() < 10 * 60_000) continue
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

  const { reminder_channel_id } = await getAppSettings()

  for (const reminder of due) {
    const targetChannelId = reminder.channel_id ?? reminder_channel_id
    if (!targetChannelId) {
      log.warn({ reminderId: reminder.id }, 'Reminder has no channel and no default set')
      continue
    }
    const channel = await client.channels.fetch(targetChannelId).catch(() => null)
    if (!channel || !channel.isTextBased() || channel.isDMBased()) {
      log.warn({ reminderId: reminder.id, targetChannelId }, 'Reminder channel unavailable')
      continue
    }
    const embed = new EmbedBuilder().setTitle('⏰ Reminder').setDescription(reminder.content)
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`reminder_ack:${reminder.id}`)
        .setLabel('Got it')
        .setStyle(ButtonStyle.Success)
    )
    try {
      const sent = await channel.send({
        content: reminder.target ? `<@${reminder.target}>` : undefined,
        embeds: [embed],
        components: [row]
      })
      await insertMessage({
        channel_id: targetChannelId,
        content: `⏰ ${reminder.content}`,
        user_id: client.user!.id,
        user_name: 'munin',
        id: sent.id,
        sent_at: sent.createdAt
      })
      await markReminderSent(reminder.id)
      log.info({ reminderId: reminder.id }, 'Reminder delivered')
    } catch (err) {
      // Leave it pending so the next poll retries; don't mark sent on failure.
      log.error({ err, reminderId: reminder.id }, 'Reminder delivery failed')
    }
  }
}

// every thread in a guild, active and archived, so a backfill misses nothing.
export async function getAllThreads(guild: Guild): Promise<AnyThreadChannel[]> {
  const byId = new Map<string, AnyThreadChannel>()
  const add = (thread: AnyThreadChannel) => byId.set(thread.id, thread)

  const active = await guild.channels.fetchActiveThreads()
  active.threads.forEach(add)

  const channels = await guild.channels.fetch()
  for (const channel of channels.values()) {
    if (!channel || !('threads' in channel)) continue

    for (const type of ['public', 'private'] as const) {
      let before: number | undefined
      let hasMore = true
      while (hasMore) {
        const page = await channel.threads
          .fetchArchived({ type, before, limit: 100, fetchAll: type === 'private' })
          .catch(() => null)
        if (!page) break

        page.threads.forEach(add)
        const oldest = page.threads.last()
        before = oldest?.archiveTimestamp ?? undefined
        hasMore = page.hasMore && !!oldest
      }
    }
  }

  return [...byId.values()]
}

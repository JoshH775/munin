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
  type Message,
} from 'discord.js'
import { listEphemeralChannelIds } from '../repositories/channelSettings'
import { deleteMessages, getLatestMessage, insertMessage } from '../repositories/messages'
import { getDueReminders, markReminderSent } from '../repositories/reminders'
import type { Tool } from '../ai/makeTool'
import { log } from '../logger'

// Chunk text to fit Discord's 2000-char message limit, breaking on newlines where possible.
export function splitForDiscord(text: string): string[] {
  const parts: string[] = []
  let rest = text
  while (rest.length > 2000) {
    let cut = rest.lastIndexOf('\n', 2000)
    if (cut <= 0) cut = 2000
    parts.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n/, '')
  }
  if (rest) parts.push(rest)
  return parts
}

// Bring the "-# Read 3 pages · Set 1 reminder" breadcrumb for this tool phase up to date with `used`:
// sent on the first tool, edited at most once a second after, stored and reset on `final`.
export async function updateBreadcrumb({
  channel,
  tools,
  used,
  breadcrumb,
  final = false,
}: {
  channel: Channel
  tools: Tool<any>[]
  used: Map<string, number>
  breadcrumb: { message: Message; at: number } | null
  final?: boolean
}): Promise<{ message: Message; at: number } | null> {
  if (used.size === 0 || !channel.isSendable()) return breadcrumb
  const labels = new Map(tools.map((t) => [t.definition.name, t.label]))
  const body = `-# ${used
    .entries()
    .map(([name, n]) => labels.get(name)!(n))
    .toArray()
    .join(' · ')}`
  if (!breadcrumb) {
    const message = await channel.send(body).catch(() => null)
    if (message) breadcrumb = { message, at: Date.now() }
  } else if (final || Date.now() - breadcrumb.at >= 1000) {
    // edit message if its the last or if its been at least one second
    breadcrumb.message.edit(body).catch(() => {})
    breadcrumb.at = Date.now()
  }
  if (!final) return breadcrumb
  used.clear()
  if (breadcrumb) {
    await insertMessage({
      channel_id: channel.id,
      content: body,
      user_id: channel.client.user!.id,
      user_name: 'munin',
      id: breadcrumb.message.id,
      sent_at: breadcrumb.message.createdAt,
      kind: 'tool',
    })
  }
  return null
}

export async function fetchAllMessages(
  channel: Channel,
  after?: string | null,
): Promise<Message[]> {
  if (!channel.isTextBased()) return []
  const messages: Message[] = []

  if (after) {
    let cursor = after
    while (true) {
      const batch: Collection<string, Message> = await channel.messages.fetch({
        limit: 100,
        after: cursor,
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
      before,
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
    const embed = new EmbedBuilder().setTitle('⏰ Reminder').setDescription(reminder.content)
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`reminder_ack:${reminder.id}`)
        .setLabel('Got it')
        .setStyle(ButtonStyle.Success),
    )
    try {
      const sent = await channel.send({
        content: reminder.target ? `<@${reminder.target}>` : undefined,
        embeds: [embed],
        components: [row],
      })
      await insertMessage({
        channel_id: targetChannelId,
        content: `⏰ ${reminder.content}`,
        user_id: client.user!.id,
        user_name: 'munin',
        id: sent.id,
        sent_at: sent.createdAt,
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

// export async function sweepMemory(client: Client, guild: Guild): Promise<void> {
//   const allChannels = (await guild.channels.fetch())
//     .values()
//     .filter((c): c is TextChannel => c?.type === ChannelType.GuildText)
//   const sweepChannels = [...allChannels].filter(async (c) => {
//     if (!c) return false
//     if (!c.messages.cache.values().some((m) => m.author.id === client.user?.id)) return false
//     const latest = await getLatestMessage(c.id)
//     if (!latest || Date.now() - latest.sent_at.getTime() < 5 * 60_000) return false
//   })
// }

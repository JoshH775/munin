import { Client, Events, GatewayIntentBits, Partials, type GuildTextBasedChannel } from 'discord.js'
import {
  deleteChannelMessages,
  deleteMessages,
  getLatestMessage,
  insertMessage,
  updateMessageContent,
} from '../repositories/messages'
import { deleteSettings } from '../repositories/channelSettings'
import { fetchAllMessages, getAllThreads } from './utils'
import { log } from '../logger'
import { dayjs } from '../time'
import { registerCommands } from './commands'
import { interactionHandler } from './interactionHandler'
import { messageHandler } from './messageHandler'

// Logs in, registers commands and backfills; resolves once the bot is ready to take messages.
export async function setupClient(): Promise<Client> {
  const token = process.env.DISCORD_BOT_TOKEN
  if (!token) throw Error('Discord bot env vars not setup properly')

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
    // partials so delete events fire for messages not in the cache (older ones)
    partials: [Partials.Message, Partials.Channel],
    // no cache sweeping, so archived threads stay cached and the memory sweep sees them
    sweepers: {},
  })

  let ready = false

  client.on(Events.MessageCreate, async (message) => {
    if (ready) messageHandler(client, message)
  })

  client.on(Events.MessageUpdate, async (old, updated) => {
    if (old.content !== null && old.content === updated.content) return // unfurl or pin, not an edit
    const message = updated.partial ? await updated.fetch().catch(() => null) : updated
    if (!message?.content.trim()) return
    log.info({ id: message.id }, 'Message edited')
    await updateMessageContent(message.id, message.content)
  })

  client.on(Events.MessageDelete, (message) => {
    log.info({ id: message.id }, 'Message deleted')
    deleteMessages([message.id])
  })

  client.on(Events.MessageBulkDelete, (messages) => {
    log.info({ count: messages.size }, 'Bulk delete')
    deleteMessages([...messages.keys()])
  })

  client.on(Events.ThreadDelete, async (thread) => {
    log.info({ threadId: thread.id }, 'Thread deleted')
    await deleteChannelMessages(thread.id)
    await deleteSettings([thread.id])
  })

  client.on(Events.ChannelDelete, async (channel) => {
    log.info({ channelId: channel.id }, 'Channel deleted')
    await deleteChannelMessages(channel.id)
    await deleteSettings([channel.id])
  })

  client.on(Events.InteractionCreate, async (interaction) => interactionHandler(interaction))

  const loggedIn = new Promise<void>((resolve) => client.once(Events.ClientReady, () => resolve()))
  await client.login(token)
  await loggedIn
  log.info({ tag: client.user!.tag }, 'Logged in')
  await registerCommands(client)
  await backfill(client)
  ready = true
  return client
}

async function backfill(client: Client): Promise<void> {
  log.info('Backfilling messages')
  const start = Date.now()
  const backfillJobs: Promise<void>[] = []
  let messageCount = 0

  const backfillChannel = async (channel: GuildTextBasedChannel) => {
    const latest = await getLatestMessage(channel.id)
    if (BigInt(channel.lastMessageId ?? 0) <= BigInt(latest?.id ?? 0)) return
    const messages = await fetchAllMessages(channel, latest?.id ?? null)
    if (messages.length === 0) return
    for (const message of messages) {
      if (message.system) continue
      const inserted = await insertMessage({
        channel_id: channel.id,
        content: message.content,
        user_name: message.author.username,
        user_id: message.author.id,
        id: message.id,
        sent_at: dayjs(message.createdAt),
      })
      if (inserted) messageCount++
    }
  }

  for (const guild of client.guilds.cache.values()) {
    const channels = [
      ...(await guild.channels.fetch()).values().filter((c) => !!c && c.isTextBased()),
      ...(await getAllThreads(guild)),
    ]
    for (const channel of channels) {
      backfillJobs.push(backfillChannel(channel))
    }
  }

  await Promise.all(backfillJobs)
  log.info({ messages: messageCount, ms: Date.now() - start }, 'Backfill complete')
}

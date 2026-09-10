import { Client, Events, GatewayIntentBits, Partials, type GuildTextBasedChannel } from 'discord.js'
import {
  deleteChannelMessages,
  deleteMessages,
  getLatestMessage,
  insertMessage,
} from '../repositories/messages'
import { deleteSettings } from '../repositories/channelSettings'
import { fetchAllMessages, getAllThreads, sweepEphemeral, dispatchReminders } from './utils'
import { log } from '../logger'
import { dayjs } from '../time'
import { registerCommands } from './commands'
import { Cron } from 'croner'
import { interactionHandler } from './interactionHandler'
import { messageHandler } from './messageHandler'

const token = process.env.DISCORD_BOT_TOKEN
if (!token) {
  throw Error('Discord bot env vars not setup properly')
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  // partials so delete events fire for messages not in the cache (older ones)
  partials: [Partials.Message, Partials.Channel],
})

client.login(token)

let ready = false

client.on(Events.MessageCreate, async (message) => {
  if (ready) messageHandler(client, message)
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

client.once(Events.ClientReady, async (c) => {
  log.info({ tag: c.user.tag }, 'Logged in')
  try {
    await registerCommands(client)
    await backfill()
    ready = true
    new Cron('* * * * *', { catch: (err) => log.error({ err }, 'Ephemeral sweep failed') }, () =>
      sweepEphemeral(client),
    )
    new Cron('* * * * *', { catch: (err) => log.error({ err }, 'Reminder dispatch failed') }, () =>
      dispatchReminders(client),
    )
  } catch (err) {
    log.fatal({ err }, 'Startup failed, exiting')
    process.exit(1)
  }
})

async function backfill(): Promise<void> {
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

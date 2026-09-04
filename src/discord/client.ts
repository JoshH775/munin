import { Client, Events, GatewayIntentBits, Partials } from 'discord.js'
import {
  deleteChannelMessages,
  deleteMessages,
  getLatestMessage,
  insertMessage,
} from '../repositories/messages'
import { deleteSettings } from '../repositories/channelSettings'
import {
  fetchAllMessages,
  getAllThreads,
  sweepEphemeral,
  dispatchReminders,
} from './utils'
import { log } from '../logger'
import {
  registerCommands,
} from './commands'
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
  const inserts: Promise<void>[] = []
  let channelCount = 0
  let threadCount = 0
  let guildCount = 0
  for (const guild of client.guilds.cache.values()) {
    const channels = await guild.channels.fetch()

    for (const channel of channels.values().filter((c) => !!c)) {
      const after = (await getLatestMessage(channel.id))?.id ?? null
      const messages = await fetchAllMessages(channel, after)
      if (messages.length === 0) continue
      for (const message of messages) {
        if (message.system) continue
        inserts.push(
          insertMessage({
            channel_id: channel.id,
            content: message.content,
            user_name: message.author.username,
            user_id: message.author.id,
            id: message.id,
            sent_at: message.createdAt,
          }),
        )
      }
      channelCount++
    }

    for (const thread of await getAllThreads(guild)) {
      if (!thread.parentId) continue
      const after = (await getLatestMessage(thread.id))?.id ?? null
      const messages = await fetchAllMessages(thread, after)
      for (const message of messages) {
        if (message.system) continue
        inserts.push(
          insertMessage({
            channel_id: thread.id,
            content: message.content,
            user_name: message.author.username,
            user_id: message.author.id,
            id: message.id,
            sent_at: message.createdAt,
          }),
        )
      }
      threadCount++
    }

    guildCount++
  }

  await Promise.all(inserts)
  log.info(
    {
      messages: inserts.length,
      channels: channelCount,
      threads: threadCount,
      guilds: guildCount,
      ms: Date.now() - start,
    },
    'Backfill complete',
  )
}

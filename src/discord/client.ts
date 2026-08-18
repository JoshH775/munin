import { ChannelType, Client, Events, GatewayIntentBits } from 'discord.js'
import {
  deleteMessages,
  getConversation,
  insertMessage,
  toChatTranscript
} from '../repositories/messages'
import { turn } from '../ai'
import { resolveSettings } from '../repositories/agentSettings'
import { log } from '../logger'

const token = process.env.DISCORD_BOT_TOKEN
if (!token) {
  throw Error('Discord bot env vars not setup properly')
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
})

client.login(token)

client.on(Events.MessageCreate, async (message) => {
  if (message.author.id === client.user?.id) return
  const channelId =
    message.channel.isThread() && message.channel.parentId
      ? message.channel.parentId
      : message.channelId
  const threadId = message.channel.isThread() ? message.channelId : null

  try {
    log.info({ channelId, threadId, user: message.author.username }, 'message received')

    await insertMessage({
      channel_id: channelId,
      content: message.content,
      user_id: message.author.id,
      user_name: message.author.username,
      thread_id: threadId,
      id: message.id,
      sent_at: message.createdAt
    })

    const [history, settings] = await Promise.all([
      getConversation({ channelId, threadId }),
      resolveSettings(channelId)
    ])

    message.channel.sendTyping()
    const result = await turn({
      messages: toChatTranscript(history, client.user!.id),
      model: settings.model,
      system: settings.persona
    })

    const sent = await message.channel.send(result.text)
    insertMessage({
      channel_id: channelId,
      content: result.text,
      user_id: client.user!.id,
      thread_id: threadId,
      user_name: 'munin',
      id: sent.id,
      sent_at: sent.createdAt
    })
    log.info({ channelId, threadId, chars: result.text.length }, 'replied')
  } catch (err) {
    log.error({ err, channelId, threadId }, 'failed to handle message')
  }
})

client.on(Events.MessageDelete, (message) => {
  log.info({ id: message.id }, 'message deleted')
  deleteMessages([message.id])
})

client.on(Events.MessageBulkDelete, (messages) => {
  log.info({ count: messages.size }, 'bulk delete')
  deleteMessages([...messages.keys()])
})

client.once(Events.ClientReady, async (c) => {
  log.info({ tag: c.user.tag }, 'logged in')
  log.info('backfilling messages')
  const start = Date.now()
  const inserts: Promise<void>[] = []
  let channelCount = 0
  let threadCount = 0
  let guildCount = 0
  for (const guild of client.guilds.cache.values()) {
    const [channels, active] = await Promise.all([
      guild.channels.fetch(),
      guild.channels.fetchActiveThreads()
    ])

    for (const channel of channels.values()) {
      if (!channel || !channel.isTextBased() || channel.isThread()) continue
      const messages = await channel.messages.fetch({ limit: 100 })
      for (const message of messages.values()) {
        inserts.push(
          insertMessage({
            channel_id: channel.id,
            content: message.content,
            user_name: message.author.username,
            user_id: message.author.id,
            id: message.id,
            thread_id: null,
            sent_at: message.createdAt
          })
        )
      }
      channelCount++
    }

    for (const thread of active.threads.values()) {
      if (!thread || !thread.isTextBased() || !thread.parentId) continue
      const messages = await thread.messages.fetch({ limit: 100 })
      for (const message of messages.values()) {
        inserts.push(
          insertMessage({
            channel_id: thread.parentId,
            content: message.content,
            user_name: message.author.username,
            user_id: message.author.id,
            id: message.id,
            thread_id: thread.id,
            sent_at: message.createdAt
          })
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
      ms: Date.now() - start
    },
    'backfill complete'
  )
})

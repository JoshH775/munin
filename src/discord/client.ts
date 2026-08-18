import { ChannelType, Client, Events, GatewayIntentBits } from 'discord.js'
import {
  deleteChannelMessages,
  deleteMessages,
  getConversation,
  insertMessage,
  toChatTranscript
} from '../repositories/messages'
import { turn } from '../ai'
import { deleteSettings, resolveSettings } from '../repositories/agentSettings'
import { getAllThreads } from './threads'
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
  const channelId = message.channelId
  const parentChannelId = message.channel.isThread() ? message.channel.parentId : null

  try {
    log.info({ channelId, parentChannelId, user: message.author.username }, 'message received')

    await insertMessage({
      channel_id: channelId,
      parent_channel_id: parentChannelId,
      content: message.content,
      user_id: message.author.id,
      user_name: message.author.username,
      id: message.id,
      sent_at: message.createdAt
    })

    const [history, settings] = await Promise.all([
      getConversation({ channelId }),
      resolveSettings(channelId, parentChannelId)
    ])

    message.channel.sendTyping()
    const transcript = toChatTranscript(history, client.user!.id)
    const result = await turn({
      messages: settings.memory.trim()
        ? [...transcript, { role: 'user' as const, content: `<memory>\n${settings.memory}\n</memory>` }]
        : transcript,
      model: settings.model,
      system: settings.persona
    })

    const sent = await message.channel.send(result.text)
    insertMessage({
      channel_id: channelId,
      parent_channel_id: parentChannelId,
      content: result.text,
      user_id: client.user!.id,
      user_name: 'munin',
      id: sent.id,
      sent_at: sent.createdAt
    })
    log.info({ channelId, parentChannelId, chars: result.text.length }, 'replied')
  } catch (err) {
    log.error({ err, channelId, parentChannelId }, 'failed to handle message')
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

client.on(Events.ThreadDelete, async (thread) => {
  log.info({ threadId: thread.id }, 'thread deleted')
  await deleteChannelMessages(thread.id)
  await deleteSettings([thread.id])
})

client.on(Events.ChannelDelete, async (channel) => {
  log.info({ channelId: channel.id }, 'channel deleted')
  await deleteChannelMessages(channel.id)
  await deleteSettings([channel.id])
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
    const channels = await guild.channels.fetch()

    for (const channel of channels.values()) {
      if (!channel || !channel.isTextBased() || channel.isThread()) continue
      const messages = await channel.messages.fetch({ limit: 100 })
      for (const message of messages.values()) {
        inserts.push(
          insertMessage({
            channel_id: channel.id,
            parent_channel_id: null,
            content: message.content,
            user_name: message.author.username,
            user_id: message.author.id,
            id: message.id,
            sent_at: message.createdAt
          })
        )
      }
      channelCount++
    }

    for (const thread of await getAllThreads(guild)) {
      if (!thread.parentId) continue
      const messages = await thread.messages.fetch({ limit: 100 }).catch(() => null)
      if (!messages) continue
      for (const message of messages.values()) {
        inserts.push(
          insertMessage({
            channel_id: thread.id,
            parent_channel_id: thread.parentId,
            content: message.content,
            user_name: message.author.username,
            user_id: message.author.id,
            id: message.id,
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

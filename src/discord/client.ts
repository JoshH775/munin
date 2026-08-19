import { ChannelType, Client, Events, GatewayIntentBits } from 'discord.js'
import {
  deleteChannelMessages,
  deleteMessages,
  getConversation,
  insertMessage,
  toChatTranscript
} from '../repositories/messages'
import { turn } from '../ai'
import { deleteSettings, resolveSettings } from '../repositories/channelSettings'
import { getAllThreads } from './threads'
import { log } from '../logger'
import { updateMemoryTool } from '../ai/tools'
import { handleConfigInteraction, registerCommands } from './commands'
import { match } from 'ts-pattern'

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

let ready = false

const TOOL_NOTE_MARKER = '\u200b'

client.on(Events.MessageCreate, async (message) => {
  if (!ready) return
  if (message.author.id === client.user?.id) return
  if (message.system) return // ignore discord system notices (thread created, pins, joins, …)
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

    const transcript = toChatTranscript(history, client.user!.id)
    await turn({
      messages: settings.memory.trim()
        ? [...transcript, { role: 'user' as const, content: `<memory>\n${settings.memory}\n</memory>` }]
        : transcript,
      model: settings.model,
      effort: settings.effort,
      system: settings.persona,
      onRoundStart: () => {
        message.channel.sendTyping().catch(() => {})
      },
      onText: async (text) => {
        const sent = await message.channel.send(text)
        await insertMessage({
          channel_id: channelId,
          parent_channel_id: parentChannelId,
          content: text,
          user_id: client.user!.id,
          user_name: 'munin',
          id: sent.id,
          sent_at: sent.createdAt
        })
      },
      onToolUse: async (tool) => {
        const input = JSON.stringify(tool.input)
        await message.channel
          .send(
            `-# Tool used: ${tool.name}(${input.length > 200 ? `${input.slice(0, 200)}…` : input})${TOOL_NOTE_MARKER}`
          )
          .catch(() => {})
      },
      tools: [updateMemoryTool(channelId, parentChannelId)],
      serverTools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }]
    })

    log.info({ channelId, parentChannelId }, 'replied')
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

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return
  try {
    await match(interaction.commandName)
      .with('config', () => handleConfigInteraction(interaction))
      .otherwise(async () => {})
  } catch (err) {
    log.error({ err, command: interaction.commandName }, 'interaction failed')
  }
})

client.once(Events.ClientReady, async (c) => {
  log.info({ tag: c.user.tag }, 'logged in')
  try {
    await registerCommands(client)
    await backfill()
    ready = true
  } catch (err) {
    log.fatal({ err }, 'startup failed, exiting')
    process.exit(1)
  }
})

async function backfill(): Promise<void> {
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
        if (message.system || message.content.includes(TOOL_NOTE_MARKER)) continue
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
        if (message.system || message.content.includes(TOOL_NOTE_MARKER)) continue
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
}

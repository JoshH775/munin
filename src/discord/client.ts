import { Client, Events, GatewayIntentBits } from 'discord.js'
import {
  deleteChannelMessages,
  deleteMessages,
  getConversation,
  getLatestMessageId,
  insertMessage,
  toChatTranscript
} from '../repositories/messages'
import { turn } from '../ai'
import {
  deleteSettings,
  resolveSettings
} from '../repositories/channelSettings'
import { fetchAllMessages, getAllThreads } from './utils'
import { log } from '../logger'
import {
  startWorkTool,
  tavilyExtractTool,
  tavilySearchTool,
  updateMemoryTool
} from '../ai/tools'
import { handleConfigInteraction, handleMuteInteraction, registerCommands } from './commands'
import { match } from 'ts-pattern'
import { insertUsage } from '../repositories/usage'

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

// Discord caps messages at 2000 chars; split long replies, preferring a line break.
function splitForDiscord(text: string): string[] {
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

client.on(Events.MessageCreate, async (message) => {
  if (!ready) return
  if (message.author.id === client.user?.id) return
  if (message.system) return // ignore discord system notices (thread created, pins, joins, …)
  const channelId = message.channelId
  const parentChannelId = message.channel.isThread()
    ? message.channel.parentId
    : null
  const channelName =
    'name' in message.channel ? message.channel.name : channelId

  try {
    log.info(
      { channelId, parentChannelId, user: message.author.username },
      'message received'
    )

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

    if (!settings.enabled) {
      log.info({ channelId }, 'channel disabled, ignoring message')
      return
    }

    const transcript = toChatTranscript(history, client.user!.id)
    const { usage } = await turn({
      messages: settings.memory.trim()
        ? [
            ...transcript,
            {
              role: 'user' as const,
              content: `<memory>\n${settings.memory}\n</memory>`
            }
          ]
        : transcript,
      model: settings.model,
      effort: settings.effort,
      system: settings.persona,
      systemSuffix: `The current date and time is ${message.createdAt.toISOString().slice(0, 16).replace('T', ' ')} UTC.`,
      onRoundStart: () => {
        message.channel.sendTyping().catch(() => {})
      },
      onText: async (text) => {
        // Spacing comes from the model now, steered by system.md examples, not chiselled here.
        // The two newline passes below collapsed GLM's airy spacing but overshot into cramped
        // walls with no paragraph breaks, so they're off while we try going natural.
        const tidy = text
          .replace(/^\s*---\s*$/gm, '') // drop horizontal rules
          // .replace(/\n{2,}/g, '\n') // single-space everything
          // .replace(/([^\n])\n(\*\*[^\n]+\*\*|#{1,6} [^\n]+)$/gm, '$1\n\n$2') // one blank line before a header
          .trim()
        if (!tidy) return
        for (const part of splitForDiscord(tidy)) {
          const sent = await message.channel.send(part)
          await insertMessage({
            channel_id: channelId,
            parent_channel_id: parentChannelId,
            content: part,
            user_id: client.user!.id,
            user_name: 'munin',
            id: sent.id,
            sent_at: sent.createdAt
          })
        }
      },
      onToolUse: async (tool) => {
        const full = `Tool used: ${tool.name}(${JSON.stringify(tool.input)})`
        const line = full.length > 45 ? `${full.slice(0, 44)}…` : full
        const sent = await message.channel.send(`-# ${line}`).catch(() => null)
        if (sent) {
          await insertMessage({
            channel_id: channelId,
            parent_channel_id: parentChannelId,
            content: full,
            user_id: client.user!.id,
            user_name: 'munin',
            id: sent.id,
            sent_at: sent.createdAt
          })
        }
      },
      tools: [
        updateMemoryTool(channelId, parentChannelId),
        startWorkTool(channelName),
        tavilySearchTool(),
        tavilyExtractTool()
      ]
    })

    await insertUsage({
      in_reply_to: message.id,
      effort: settings.effort,
      model: settings.model,
      ...usage
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
      .with('mute', () => handleMuteInteraction(interaction))
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

    for (const channel of channels.values().filter((c) => !!c)) {
      const after = await getLatestMessageId(channel.id)
      const messages = await fetchAllMessages(channel, after)
      if (messages.length === 0) continue
      for (const message of messages) {
        if (message.system) continue
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
      const after = await getLatestMessageId(thread.id)
      const messages = await fetchAllMessages(thread, after)
      for (const message of messages) {
        if (message.system) continue
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

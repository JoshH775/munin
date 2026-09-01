import { ChannelType, Client, EmbedBuilder, Events, GatewayIntentBits, Partials } from 'discord.js'
import {
  deleteChannelMessages,
  deleteMessages,
  getConversation,
  getLatestMessage,
  insertMessage,
  toChatTranscript
} from '../repositories/messages'
import { turn } from '../ai'
import {
  deleteSettings,
  resolveSettings
} from '../repositories/channelSettings'
import { fetchAllMessages, getAllThreads, sweepEphemeral, dispatchReminders } from './utils'
import { log } from '../logger'
import {
  channelTreeTool,
  createCategoryTool,
  deleteCategoryTool,
  setChannelCategoryTool,
  tavilyExtractTool,
  tavilySearchTool,
  createReminderTool,
  deleteReminderTool,
  listRemindersTool,
  updateMemoryTool
} from '../ai/tools'
import { findUrls } from '../urls'
import {
  handleClearInteraction,
  handleConfigInteraction,
  handleEphemeralInteraction,
  handleMemoryInteraction,
  handleMuteInteraction,
  handleSettingsInteraction,
  registerCommands
} from './commands'
import { Cron } from 'croner'
import { match } from 'ts-pattern'
import { insertUsage } from '../repositories/usage'
import { markReminderReceived } from '../repositories/reminders'

const token = process.env.DISCORD_BOT_TOKEN
if (!token) {
  throw Error('Discord bot env vars not setup properly')
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  // partials so delete events fire for messages not in the cache (older ones)
  partials: [Partials.Message, Partials.Channel]
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
  const channelName = message.channel.isThread()
    ? `#${message.channel.parent?.name ?? 'unknown'} (thread: ${message.channel.name})`
    : `#${'name' in message.channel ? message.channel.name : channelId}`
  try {
    log.info(
      { channelId, parentChannelId, user: message.author.username },
      'Message received'
    )

    await insertMessage({
      channel_id: channelId,
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
      log.info({ channelId }, 'Channel disabled, ignoring message')
      return
    }

    const transcript = toChatTranscript(history, client.user!.id)
    const trustedUrls = new Set<string>()
    for (const m of history) {
      if (m.user_id === client.user!.id) continue
      for (const url of findUrls(m.content)) trustedUrls.add(url)
    }
    const tools = [
      // ephemeral channels are throwaway: no memory tool, so nothing here is remembered
      ...(settings.ephemeral
        ? []
        : [updateMemoryTool(channelId, parentChannelId)]),
      tavilySearchTool(trustedUrls),
      tavilyExtractTool(trustedUrls),
      channelTreeTool(client),
      createReminderTool(client, message.author.id),
      deleteReminderTool(),
      listRemindersTool(),
      deleteCategoryTool(client),
      setChannelCategoryTool(client),
      ...(message.guild ? [createCategoryTool(client, message.guild)] : [])
    ]
    const toolNames = new Set(tools.map((t) => t.definition.name))
    const systemSuffix = [
      `The current date and time is ${message.createdAt.toISOString().slice(0, 16).replace('T', ' ')} UTC.`,
      `You are in ${channelName}.`,
      settings.memory.trim() && `<memory>\n${settings.memory}\n</memory>`
    ]
      .filter(Boolean)
      .join('\n\n')
    const turnStart = Date.now()
    const { usage, truncated, rounds } = await turn({
      messages: transcript,
      model: settings.model,
      effort: settings.effort,
      system: settings.persona,
      systemSuffix,
      onRoundStart: () => {
        message.channel.sendTyping().catch(() => {})
      },
      onText: async (text) => {
        const tidy = text
          .replace(/^\s*---\s*$/gm, '') // drop horizontal rules
          .trim()
        if (!tidy) return
        const parts = splitForDiscord(tidy)
        if (parts.length > 1) {
          log.info({ channelId, parts: parts.length }, 'Reply split across messages')
        }
        for (const part of parts) {
          const sent = await message.channel.send(part)
          await insertMessage({
            channel_id: channelId,
            content: part,
            user_id: client.user!.id,
            user_name: 'munin',
            id: sent.id,
            sent_at: sent.createdAt
          })
        }
      },
      onToolUse: async (tool) => {
        if (!toolNames.has(tool.name)) return
        const full = `Tool used: ${tool.name}(${JSON.stringify(tool.input)})`
        const line = full.length > 45 ? `${full.slice(0, 44)}…` : full
        const sent = await message.channel.send(`-# ${line}`).catch(() => null)
        if (sent) {
          await insertMessage({
            channel_id: channelId,
            content: full,
            user_id: client.user!.id,
            user_name: 'munin',
            id: sent.id,
            sent_at: sent.createdAt
          })
        }
      },
      onThinking: async () => {
        const sent = await message.channel
          .send(`-# *Thinking...*`)
          .catch(() => null)
        if (sent) {
          await insertMessage({
            channel_id: channelId,
            content: sent.content,
            user_id: client.user!.id,
            id: sent.id,
            user_name: 'munin',
            sent_at: sent.createdAt
          })
        }
      },
      tools
    })

    await insertUsage({
      in_reply_to: message.id,
      effort: settings.effort,
      model: settings.model,
      ...usage
    })

    if (truncated) {
      await message.channel.send('**Turn limit reached, output truncated.**')
    }

    const channel = client.channels.cache.get(channelId)
    if (channel?.type === ChannelType.GuildText && !settings.ephemeral) {
      if (channel.position !== 0) channel.setPosition(0).catch((err) => log.error({ err, channelId }, 'Reorder failed'))
      if (channel.parent && channel.parent.position !== 0) channel.parent.setPosition(0).catch((err) => log.error({ err, channelId }, 'Reorder failed'))
    }
    

    log.info(
      {
        channelId,
        model: settings.model,
        effort: settings.effort,
        rounds,
        ms: Date.now() - turnStart,
        tokens: {
          in: usage.input_tokens,
          out: usage.output_tokens,
          cacheRead: usage.cache_read_input_tokens
        },
        ...(truncated ? { truncated: true } : {})
      },
      'Replied'
    )
  } catch (err) {
    log.error({ err, channelId, parentChannelId }, 'Failed to handle message')
  }
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

client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isButton()) {
    const [action, id] = interaction.customId.split(':')
    if (action !== 'reminder_ack' || !id) return
    try {
      await markReminderReceived(id)
      const embed = EmbedBuilder.from(interaction.message.embeds[0])
        .setColor(0x3bb273)
        .setFooter({ text: `Acknowledged by ${interaction.user.username}` })
      await interaction.update({ embeds: [embed], components: [] })
    } catch (err) {
      log.error({ err, customId: interaction.customId }, 'Reminder ack failed')
    }
    return
  }
  if (!interaction.isChatInputCommand()) return
  try {
    await match(interaction.commandName)
      .with('config', () => handleConfigInteraction(interaction))
      .with('settings', () => handleSettingsInteraction(interaction))
      .with('memory', () => handleMemoryInteraction(interaction))
      .with('mute', () => handleMuteInteraction(interaction))
      .with('ephemeral', () => handleEphemeralInteraction(interaction))
      .with('clear', () => handleClearInteraction(interaction))
      .otherwise(async () => {})
  } catch (err) {
    log.error({ err, command: interaction.commandName }, 'Interaction failed')
  }
})

client.once(Events.ClientReady, async (c) => {
  log.info({ tag: c.user.tag }, 'Logged in')
  try {
    await registerCommands(client)
    await backfill()
    ready = true
    new Cron(
      '* * * * *',
      { catch: (err) => log.error({ err }, 'Ephemeral sweep failed') },
      () => sweepEphemeral(client)
    )
    new Cron(
      '* * * * *',
      { catch: (err) => log.error({ err }, 'Reminder dispatch failed') },
      () => dispatchReminders(client)
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
            sent_at: message.createdAt
          })
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
    'Backfill complete'
  )
}

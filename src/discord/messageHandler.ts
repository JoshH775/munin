import { Message, ChannelType, Client, type OmitPartialGroupDMChannel } from 'discord.js'
import { turn } from '../ai'
import {
  updateMemoryTool,
  tavilySearchTool,
  tavilyExtractTool,
  createReminderTool,
  deleteReminderTool,
  listRemindersTool,
  deleteCategoryTool,
  setChannelCategoryTool,
  createCategoryTool,
  channelTreeTool,
  renameCategoryTool,
  searchMessagesTool,
} from '../ai/tools'
import { resolveSettings } from '../repositories/channelSettings'
import { insertMessage, getConversation, toChatTranscript } from '../repositories/messages'
import { insertUsage } from '../repositories/usage'
import { findUrls } from '../urls'
import { postPendingTools, splitForDiscord } from './utils'
import { log } from '../logger'

export async function messageHandler(
  client: Client,
  message: OmitPartialGroupDMChannel<Message<boolean>>,
): Promise<void> {
  if (message.author.id === client.user?.id) return
  if (message.system) return // ignore discord system notices (thread created, pins, joins, …)
  const channelId = message.channelId
  const parentChannelId = message.channel.isThread() ? message.channel.parentId : null
  const channelName = message.channel.isThread()
    ? `#${message.channel.parent?.name ?? 'unknown'} (thread: ${message.channel.name})`
    : `#${'name' in message.channel ? message.channel.name : channelId}`
  try {
    log.info({ channelId, parentChannelId, user: message.author.username }, 'Message received')

    await insertMessage({
      channel_id: channelId,
      content: message.content,
      user_id: message.author.id,
      user_name: message.author.username,
      id: message.id,
      sent_at: message.createdAt,
    })

    const [history, settings] = await Promise.all([
      getConversation({ channelId }),
      resolveSettings(channelId, parentChannelId),
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
      ...(settings.ephemeral ? [] : [updateMemoryTool(channelId, parentChannelId)]),
      tavilySearchTool(trustedUrls),
      tavilyExtractTool(trustedUrls),
      createReminderTool(client, message.author.id),
      deleteReminderTool(),
      listRemindersTool(),
      deleteCategoryTool(client),
      renameCategoryTool(client),
      searchMessagesTool(client),
      setChannelCategoryTool(client),
      ...(message.guild
        ? [createCategoryTool(client, message.guild), channelTreeTool(client, message.guild)]
        : []),
    ]
    const systemSuffix = [
      `The current date and time is ${message.createdAt.toISOString().slice(0, 16).replace('T', ' ')} UTC.`,
      `You are in ${channelName}.`,
      settings.memory.trim() && `<memory>\n${settings.memory}\n</memory>`,
    ]
      .filter(Boolean)
      .join('\n\n')
    // Tool calls buffer here and post as one line before munin next speaks and at turn end.
    const pendingTools: string[] = []
    const turnStart = Date.now()

    let typing: ReturnType<typeof setInterval> | null = null
    const stopTyping = () => {
      if (typing) clearInterval(typing)
      typing = null
    }
    const { usage, truncated, rounds } = await turn({
      messages: transcript,
      model: settings.model,
      effort: settings.effort,
      system: settings.persona,
      systemSuffix,
      onRoundStart: () => {
        stopTyping() // never stack two intervals across rounds
        message.channel.sendTyping().catch(() => {})
        typing = setInterval(() => message.channel.sendTyping().catch(() => {}), 8000)
      },
      onText: async (text) => {
        stopTyping()
        await postPendingTools(message.channel, tools, pendingTools)
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
            sent_at: sent.createdAt,
          })
        }
      },
      onToolUse: (tool) => {
        pendingTools.push(tool.name)
      },
      tools,
    }).finally(stopTyping)
    await postPendingTools(message.channel, tools, pendingTools)

    await insertUsage({
      in_reply_to: message.id,
      effort: settings.effort,
      model: settings.model,
      ...usage,
    })

    if (truncated) {
      await message.channel.send('**Turn limit reached, output truncated.**')
    }

    const channel = client.channels.cache.get(channelId)
    if (channel?.type === ChannelType.GuildText && !settings.ephemeral) {
      if (channel.position !== 0)
        channel.setPosition(0).catch((err) => log.error({ err, channelId }, 'Reorder failed'))
      if (channel.parent && channel.parent.position !== 0)
        channel.parent
          .setPosition(0)
          .catch((err) => log.error({ err, channelId }, 'Reorder failed'))
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
          cacheRead: usage.cache_read_input_tokens,
        },
        ...(truncated ? { truncated: true } : {}),
      },
      'Replied',
    )
  } catch (err) {
    log.error({ err, channelId, parentChannelId }, 'Failed to handle message')
  }
}

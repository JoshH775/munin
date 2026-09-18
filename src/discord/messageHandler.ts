import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Message, ChannelType, Client, type OmitPartialGroupDMChannel } from 'discord.js'
import { turn, verify } from '../ai'
import type { ToolOutcome } from '../ai/executeTool'
import {
  updateChannelMemoryTool,
  updateGlobalMemoryTool,
  readMemoryTool,
  tavilySearchTool,
  tavilyExtractTool,
  createReminderTool,
  deleteReminderTool,
  listRemindersTool,
  channelTreeTool,
  createChannelTool,
  createThreadTool,
  deleteCategoryTool,
  setChannelCategoryTool,
  renameCategoryTool,
  editChannelTool,
  postMessageTool,
  editMessageTool,
  pinMessageTool,
  searchMessagesTool,
  toolLogTool,
  platesTools,
} from '../ai/tools'
import { resolveSettings } from '../repositories/channelSettings'
import { resolveMemory } from '../repositories/memory'
import { getAppSettings } from '../repositories/appSettings'
import { insertMessage, getConversation, toChatTranscript } from '../repositories/messages'
import { insertUsage } from '../repositories/usage'
import { insertToolLog, searchToolLog } from '../repositories/toolLog'
import { findUrls } from '../urls'
import { dayjs } from '../time'
import { splitForDiscord, postToolBreadcrumb } from './utils'
import { log } from '../logger'

const persona = readFileSync(
  fileURLToPath(new URL('../../system.md', import.meta.url)),
  'utf8',
).trim()

export async function messageHandler(
  client: Client,
  message: OmitPartialGroupDMChannel<Message<boolean>>,
): Promise<void> {
  if (message.system) return // ignore discord system notices (thread created, pins, joins, …)
  if (!message.inGuild()) return // no DM intent, so this only narrows the type
  const channelId = message.channelId
  const parentChannelId = message.channel.isThread() ? message.channel.parentId : null
  try {
    const own = message.author.id === client.user?.id
    await insertMessage({
      channel_id: channelId,
      content: message.content,
      user_id: message.author.id,
      user_name: message.author.username,
      id: message.id,
      sent_at: dayjs(message.createdAt),
      kind: own && message.content.startsWith('-# ') ? 'tool' : 'chat',
    })
    if (own) return

    log.info({ channelId, parentChannelId, user: message.author.username }, 'Message received')

    const [history, settings, memory, app, priorOutcomes] = await Promise.all([
      getConversation({ channelId }),
      resolveSettings(channelId, parentChannelId),
      resolveMemory(channelId, parentChannelId),
      getAppSettings(),
      searchToolLog({ channelId }).then((rows) =>
        rows.map((r): ToolOutcome => ({ output: r.output ?? '', tainted: false, ms: r.duration_ms, error: r.error })),
      ),
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
      // ephemeral channels are throwaway: no memory tools, so nothing here is remembered
      ...(settings.ephemeral ? [] : [updateChannelMemoryTool(), updateGlobalMemoryTool()]),
      readMemoryTool(),
      tavilySearchTool(trustedUrls),
      tavilyExtractTool(trustedUrls),
      createReminderTool(client, message.author.id),
      deleteReminderTool(),
      listRemindersTool(),
      deleteCategoryTool(client),
      renameCategoryTool(client),
      editChannelTool(client),
      searchMessagesTool(),
      pinMessageTool(client),
      postMessageTool(client),
      editMessageTool(client),
      setChannelCategoryTool(client),
      toolLogTool(channelId),
      ...platesTools(),
      createChannelTool(message.guild),
      createThreadTool(message.guild),
      channelTreeTool(client, message.guild),
    ]
    const parent = message.channel.isThread() ? message.channel.parent : null
    // A thread has no topic of its own, so it shows its parent's.
    const topicOwner = parent ?? message.channel
    const topic = 'topic' in topicOwner ? topicOwner.topic : null
    const systemSuffix = [
      `The current date and time is ${dayjs(message.createdAt).tz().format('dddd D MMMM YYYY HH:mm')}, London time.`,
      message.channel.isThread()
        ? `You are in ${message.channel.name} (id ${channelId}), a thread of #${parent?.name ?? 'unknown'} (id ${parentChannelId}).`
        : `You are in #${message.channel.name} (id ${channelId}).`,
      topic && `The channel topic is "${topic}".`,
      settings.ephemeral &&
        'This channel is ephemeral: it clears itself a few minutes after the last message and nothing said here is remembered.',
      memory.trim() && `<memory>\n${memory}\n</memory>`,
    ]
      .filter(Boolean)
      .join('\n\n')
    const outcomes: ToolOutcome[] = [...priorOutcomes]
    // Tools used since the last breadcrumb; postToolBreadcrumb posts and clears it.
    const used = new Map<string, number>()
    const turnStart = Date.now()

    let typing: ReturnType<typeof setInterval> | null = null
    const stopTyping = () => {
      if (typing) clearInterval(typing)
      typing = null
    }
    const { usage, truncated, rounds } = await turn({
      messages: transcript,
      model: app.chat_model,
      effort: app.effort,
      system: persona,
      systemSuffix,
      onRoundStart: () => {
        stopTyping() // never stack two intervals across rounds
        message.channel.sendTyping().catch(() => {})
        typing = setInterval(() => message.channel.sendTyping().catch(() => {}), 8000)
      },
      onText: async (text) => {
        stopTyping()
        await postToolBreadcrumb({ channel: message.channel, tools, used })
        const tidy = text
          .replace(/^\s*---\s*$/gm, '') // drop horizontal rules
          .trim()
        if (!tidy) return
        const passed = await verify(outcomes, tidy)
        if (!passed) log.warn({ channelId }, 'Verifier flagged response')
        const parts = splitForDiscord(tidy)
        if (parts.length > 1) {
          log.info({ channelId, parts: parts.length }, 'Reply split across messages')
        }
        for (const part of parts) {
          await message.channel.send(part)
        }
      },
      onToolUse: async (tool, outcome) => {
        used.set(tool.name, (used.get(tool.name) ?? 0) + 1)
        outcomes.push(outcome)
        await insertToolLog({
          in_reply_to: message.id,
          channel_id: channelId,
          tool: tool.name,
          input: JSON.stringify(tool.input),
          output: outcome.output,
          error: outcome.error,
          duration_ms: outcome.ms,
        }).catch((err) => log.error({ err, tool: tool.name }, 'Tool log insert failed'))
      },
      tools,
    }).finally(stopTyping)
    await postToolBreadcrumb({ channel: message.channel, tools, used })

    await insertUsage({
      in_reply_to: message.id,
      effort: app.effort,
      model: app.chat_model,
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
        model: app.chat_model,
        effort: app.effort,
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

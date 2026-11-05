import { log } from '../logger'
import { dayjs } from '../time'
import type { Selectable } from 'kysely'
import type { Messages } from '../db/types'
import { insertUsage } from '../repositories/usage'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { client } from '.'
import type { Client, GuildMember, TextChannel, TextThreadChannel } from 'discord.js'
import { getConversation } from '../repositories/messages'
import { getMemory, writeEncoding } from '../repositories/memory'
import { getLastEncodedAt } from '../repositories/channelSettings'
import z from 'zod'
import { XMLParser } from 'fast-xml-parser'

const semanticSystem = readFileSync(
  fileURLToPath(new URL('./encode.md', import.meta.url)),
  'utf8',
).trim()

const xml = new XMLParser({ parseTagValue: false })

// escape every < but our own tags, so a stray one in the text can't open a tag
function parseXml(raw: string) {
  let safe = raw.replaceAll('<', '&lt;')
  for (const tag of ['memory', 'description']) {
    safe = safe.replaceAll(`&lt;${tag}>`, `<${tag}>`).replaceAll(`&lt;/${tag}>`, `</${tag}>`)
  }
  return xml.parse(safe)
}

// one transcript for both encoding calls, speakers named as the prompts expect
function toTranscript(
  messages: Selectable<Messages>[],
  muninId: string,
  owner: GuildMember,
): string {
  const speaker = (m: Selectable<Messages>) =>
    m.user_id === muninId ? 'Munin' : m.user_id === owner.id ? owner.displayName : m.user_name
  return (
    messages
      // 'tool'/'thinking' are munin's status lines; contentless rows are attachments and embeds
      .filter((m) => m.kind === 'chat' && m.content.trim())
      .map((m) => `[${m.sent_at.tz().format('YYYY-MM-DD HH:mm')}] ${speaker(m)}: ${m.content}`)
      .join('\n')
  )
}

async function encodeSemantic(opts: {
  channelName: string
  owner: string
  memory: string
  transcript: string
  isRetry?: boolean
}) {
  const { channelName, owner, memory, transcript, isRetry = false } = opts
  // cheap model first; the retry runs on the stronger one
  const model = isRetry ? 'zai-org/GLM-5.2' : 'deepseek-ai/DeepSeek-V4.1-Flash'
  const SemanticSchema = z.object({ memory: z.string().min(1), description: z.string().min(1) })
  const start = dayjs()

  try {
    const res = await client.chat.completions.create({
      model,
      max_tokens: 16000,
      // DeepSeek only reasons when an effort is set
      reasoning_effort: 'high',
      messages: [
        { role: 'system', content: semanticSystem.replaceAll('{owner}', owner) },
        {
          role: 'user',
          content: [
            `Channel: ${channelName}`,
            `Now: ${dayjs().tz().format('dddd D MMMM YYYY HH:mm')}, London time.`,
            `<memory>\n${memory.trim()}\n</memory>`,
            `<messages>\n${transcript}\n</messages>`,
          ].join('\n\n'),
        },
      ],
    })
    await insertUsage({
      in_reply_to: null,
      model,
      effort: 'high',
      input_tokens: res.usage?.prompt_tokens ?? 0,
      output_tokens: res.usage?.completion_tokens ?? 0,
      cache_read_input_tokens: res.usage?.prompt_tokens_details?.cached_tokens ?? 0,
    })

    const raw = res.choices[0].message.content ?? ''
    // a cut-off reply can carry tags from leaked reasoning, so never trust one
    if (res.choices[0].finish_reason === 'length') throw new Error('Semantic encoding was cut off')
    if (raw.includes('NO_CHANGE') && !raw.includes('<memory>')) return null
    const parsed = SemanticSchema.safeParse(parseXml(raw))
    if (!parsed.success) {
      log.warn(
        { raw: raw.slice(0, 300), finish: res.choices[0].finish_reason, ms: dayjs().diff(start) },
        'Semantic encoding returned unexpected shape',
      )
      throw new Error('Semantic encoding returned unexpected shape')
    }

    return { content: parsed.data.memory, description: parsed.data.description }
  } catch (err) {
    log.warn({ err, ms: dayjs().diff(start) }, 'Semantic encoding failed')
    if (!isRetry) {
      return encodeSemantic({ ...opts, isRetry: true })
    }
    throw err
  }
}

// channels mid-encoding, so the cron and /remember never run one twice at once
const encoding = new Set<string>()

export async function encodeChannel(
  channel: TextChannel | TextThreadChannel,
  discordClient: Client,
) {
  if (encoding.has(channel.id)) return
  encoding.add(channel.id)
  try {
    const [conversation, currentSemantic, lastEncoded, owner] = await Promise.all([
      getConversation({ channelId: channel.id }),
      getMemory(channel.id),
      getLastEncodedAt(channel.id),
      channel.guild.fetchOwner(),
    ])

    const newMessages = conversation.filter((m) => !lastEncoded || m.sent_at.isAfter(lastEncoded))
    if (!newMessages.length) return
    const transcript = toTranscript(newMessages, discordClient.user!.id, owner)

    const semantic = await encodeSemantic({
      channelName: channel.name,
      owner: owner.displayName,
      memory: currentSemantic?.content ?? '',
      transcript,
    })

    // null semantic (NO_CHANGE) still moves the watermark, or the same messages re-encode every run
    await writeEncoding({
      channelId: channel.id,
      semantic,
      // the last message read, not now: anything sent mid-encode stays for the next run
      lastEncodedAt: newMessages.at(-1)!.sent_at,
    })
  } finally {
    encoding.delete(channel.id)
  }
}

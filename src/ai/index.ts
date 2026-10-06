import 'dotenv/config'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Selectable } from 'kysely'
import type { Tool } from './makeTool'
import { executeTool, type ToolOutcome } from './executeTool'
import type { Messages } from '../db/types'
import { insertUsage } from '../repositories/usage'
import { log } from '../logger'
import OpenAI from 'openai'
import z from 'zod'
import { dayjs } from '../time'

const client = new OpenAI({
  apiKey: process.env.DEEPINFRA_API_KEY,
  baseURL: 'https://api.deepinfra.com/v1/openai',
})

const verifierSystem = readFileSync(
  fileURLToPath(new URL('./verifier.md', import.meta.url)),
  'utf8',
).trim()

const sweepSystem = readFileSync(
  fileURLToPath(new URL('./sweep.md', import.meta.url)),
  'utf8',
).trim()

export const efforts = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export type Effort = (typeof efforts)[number]

export type TurnParams = {
  messages: readonly OpenAI.ChatCompletionMessageParam[]
  system: string | (() => string)
  // per-run/per-user text that sits after the cached static system block
  systemSuffix?: string
  model: string
  tools?: Tool<any>[]
  maxTokens?: number
  effort?: Effort
  onRoundStart?: () => void
  onToolUse?: (
    tool: OpenAI.ChatCompletionMessageFunctionToolCall,
    outcome: ToolOutcome,
  ) => void | Promise<void>
  onText?: (text: string) => void | Promise<void>
  onThinking?: () => void
  verify?: (outcomes: ToolOutcome[], response: string) => Promise<boolean>
}

export async function turn(params: TurnParams): Promise<{
  messages: OpenAI.ChatCompletionMessageParam[]
  usage: {
    input_tokens: number
    output_tokens: number
    cache_read_input_tokens: number
  }
  rounds: number
  truncated?: boolean
}> {
  const {
    messages,
    tools = [],
    onToolUse,
    onText,
    onThinking,
    onRoundStart,
    model,
    maxTokens = 16384,
    effort,
    system,
    systemSuffix,
    verify,
  } = params
  const definitions = tools.map((t) => t.definition)

  let rounds = 0
  let tainted = false
  let retried = false
  let temperature: number | undefined
  const outcomes: ToolOutcome[] = []

  const conversation: OpenAI.ChatCompletionMessageParam[] = [
    { role: 'system' as const, content: system instanceof Function ? system() : system },
    ...(systemSuffix ? [{ role: 'system' as const, content: systemSuffix }] : []),
    ...messages,
  ]

  let usageTotals = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
  }

  // rounds are API round trips, not conversational turns
  for (let round = 0; round < 30; round++) {
    rounds++
    onRoundStart?.()

    const response = await client.chat.completions.create({
      messages: conversation,
      model: model,
      max_tokens: maxTokens,
      tools: definitions,
      ...(effort && { reasoning_effort: effort }),
      ...(temperature != null && { temperature }),
      tool_choice: 'auto',
    })

    usageTotals.input_tokens += response.usage?.prompt_tokens ?? 0
    usageTotals.output_tokens += response.usage?.completion_tokens ?? 0
    usageTotals.cache_read_input_tokens += response.usage?.prompt_tokens_details?.cached_tokens ?? 0

    const msg = response.choices[0].message
    const reasoningContent = 'reasoning_content' in msg ? msg.reasoning_content : undefined

    conversation.push({ role: 'assistant', content: msg.content, tool_calls: msg.tool_calls })

    if (reasoningContent) onThinking?.()

    const stopReason = response.choices[0].finish_reason

    if (msg.content) {
      const terminal = stopReason !== 'tool_calls'
      const flagged = terminal && verify != null && !(await verify(outcomes, msg.content))
      if (flagged && !retried) {
        // Regenerate from the tool results already gathered, hotter, without re-running tools.
        log.warn({ model }, 'Verifier flagged response, regenerating at higher temperature')
        retried = true
        temperature = 1.3
        conversation.pop()
        continue
      }
      if (flagged) {
        log.warn({ model }, 'Verifier flagged retry, sending with caveat')
        await onText?.(
          msg.content +
            "\n\n-# Couldn't verify the specifics above against my sources, so treat the exact figures with caution.",
        )
      } else {
        await onText?.(msg.content)
      }
    }

    const toolResults: OpenAI.ChatCompletionMessageParam[] = []

    for (const toolCall of msg.tool_calls ?? []) {
      if (toolCall.type !== 'function') {
        log.warn({ toolCall }, 'Unexpected tool call type')
        continue
      }
      const outcome = await executeTool(tools, toolCall, tainted)
      await onToolUse?.(toolCall, outcome)
      outcomes.push(outcome)
      toolResults.push({
        tool_call_id: toolCall.id,
        content: outcome.output,
        role: 'tool',
      })
      tainted ||= outcome.tainted
    }

    if (stopReason === 'length') {
      log.warn({ maxTokens }, 'Hit max_tokens, output truncated')
      return {
        messages: conversation,
        usage: usageTotals,
        rounds,
        truncated: true,
      }
    }

    if (stopReason !== 'tool_calls') {
      return {
        messages: conversation,
        usage: usageTotals,
        rounds,
      }
    }

    conversation.push(...toolResults)
  }

  return {
    messages: conversation,
    usage: usageTotals,
    rounds,
  }
}

export async function verify(outcomes: ToolOutcome[], response: string): Promise<boolean> {
  const VerifierSchema = z.object({
    reason: z.string(),
    passed: z.boolean(),
  })

  const outputs = outcomes
    .map((o) => o.output)
    .filter(Boolean)
    .join('\n\n---\n\n')
  if (!outputs) return true

  const start = dayjs()
  try {
    const res = await client.chat.completions.create({
      model: 'deepseek-ai/DeepSeek-V4-Flash-0731',
      temperature: 0,
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'verdict', strict: true, schema: VerifierSchema.toJSONSchema() },
      },
      messages: [
        {
          role: 'system',
          content: verifierSystem,
        },
        {
          role: 'user',
          content: `<tool_outputs>\n${outputs}\n</tool_outputs>\n\n<response>\n${response}\n</response>`,
        },
      ],
    })

    const raw = res.choices[0].message.content ?? ''
    const parsed = VerifierSchema.safeParse(JSON.parse(raw))
    if (!parsed.success) {
      log.warn({ raw: raw.slice(0, 300), ms: dayjs().diff(start) }, 'Verifier returned unexpected shape')
      return true
    }
    const { passed, reason } = parsed.data
    log.info({ passed, reason, ms: dayjs().diff(start) }, 'Verifier verdict')
    return passed
  } catch (err) {
    log.error({ err, ms: dayjs().diff(start) }, 'Verifier failed')
    return true
  }
}

export async function listModelIds(): Promise<string[]> {
  const res = await client.models.list()
  return res.data
    .filter((m: any) => m.metadata?.tags?.includes('chat'))
    .map((m) => m.id)
}

export async function sweepMemory(opts: { channelName: string, messages: Selectable<Messages>[], doc: string, muninId: string, joshId: string, isRetry?: boolean }) {
  const { messages, channelName, doc, muninId, joshId, isRetry = false } = opts
  // cheap model first; a malformed reply retries once on the stronger one
  const model = isRetry ? 'zai-org/GLM-5.2' : 'XiaomiMiMo/MiMo-V2.6-Flash'
  const speaker = (m: Selectable<Messages>) =>
    m.user_id === muninId ? 'Munin' : m.user_id === joshId ? 'Josh' : m.user_name

  const transcript = messages
  .map((m) => `[${m.sent_at.tz().format('YYYY-MM-DD HH:mm')}] ${speaker(m)}: ${m.content}`)
  .join('\n')

  const start = dayjs()

  try {
    const res = await client.chat.completions.create({
      model,
      max_tokens: 16000,
      messages: [
        { role: 'system', content: sweepSystem },
        {
          role: 'user',
          content: [
            `Channel: ${channelName}`,
            `Now: ${dayjs().tz().format('dddd D MMMM YYYY HH:mm')}, London time.`,
            `<memory>\n${doc.trim()}\n</memory>`,
            `<messages>\n${transcript}\n</messages>`,
          ].join('\n\n'),
        },
      ],
    })
    await insertUsage({
      in_reply_to: null,
      model,
      effort: 'default',
      input_tokens: res.usage?.prompt_tokens ?? 0,
      output_tokens: res.usage?.completion_tokens ?? 0,
      cache_read_input_tokens: res.usage?.prompt_tokens_details?.cached_tokens ?? 0,
    })

    const raw = res.choices[0].message.content ?? ''
    if (raw.includes('NO_CHANGE') && !raw.includes('<memory>')) return { memory: null, description: null }
    // the last block: a glitched first attempt can leave a stray tag in an earlier one
    const description = raw.includes('<description>')
      ? raw.split('<description>').at(-1)?.split('</description>')[0]?.trim()
      : undefined
    const memory = raw.split('<memory>')[1]?.split('</memory>')[0]?.trim()
    if (!description || description.includes('<') || !memory || !raw.includes('</memory>')) {
      log.warn({ raw: raw.slice(0, 300), finish: res.choices[0].finish_reason, ms: dayjs().diff(start) }, 'Sweeper returned unexpected shape')
      throw new Error('Sweeper returned unexpected shape')
    }

    return { memory, description }
  } catch (err) {
    log.error({ err, ms: dayjs().diff(start) }, 'Sweeper failed')
    if (!isRetry) {
      log.info({ channelName }, 'Retrying sweeper on GLM-5.2')
      return sweepMemory({ ...opts, isRetry: true })
    }
    throw err
  }
    
      


}
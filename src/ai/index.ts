import 'dotenv/config'
import type { Tool } from './makeTool'
import { executeTool, type ToolOutcome } from './executeTool'
import { log } from '../logger'
import { searchToolLog } from '../repositories/toolLog'
import OpenAI from 'openai'
import z from 'zod'
import { dayjs } from '../time'

const client = new OpenAI({
  apiKey: process.env.DEEPINFRA_API_KEY,
  baseURL: 'https://api.deepinfra.com/v1/openai',
})

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
  channelId?: string
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
    maxTokens = 4096,
    effort,
    system,
    systemSuffix,
    channelId,
    verify,
  } = params
  const definitions = tools.map((t) => t.definition)

  let rounds = 0
  let tainted = false
  let retried = false
  let temperature: number | undefined
  const outcomes: ToolOutcome[] = []
  if (verify && channelId) {
    const rows = await searchToolLog({ channelId })
    for (const r of rows) {
      outcomes.push({ output: r.output ?? '', tainted: false, ms: r.duration_ms, error: r.error })
    }
  }

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
    passed: z.boolean(),
    reason: z.string().optional(),
  })

  const outputs = outcomes
    .map((o) => o.output)
    .filter(Boolean)
    .join('\n\n---\n\n')

  const start = dayjs()
  try {
    const res = await client.chat.completions.create({
      model: 'deepseek-ai/DeepSeek-V4-Flash-0731',
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content:
            'You check whether a response is supported by the tool outputs it was based on. ' +
            'Flag only specific factual claims (prices, dates, distances, quantities, specs) that the tool ' +
            'outputs do not contain. General knowledge, reasoning, and advice are fine, and any claim the ' +
            'outputs do support is fine. Respond with JSON: { "passed": true } when every specific claim is ' +
            'supported, or { "passed": false, "reason": "<the unsupported claim(s)>" } otherwise.',
        },
        {
          role: 'user',
          content: `<tool_outputs>\n${outputs}\n</tool_outputs>\n\n<response>\n${response}\n</response>`,
        },
      ],
    })

    const content = VerifierSchema.parse(JSON.parse(res.choices[0].message.content ?? ''))
    log.info({ passed: content.passed, reason: content.reason, ms: dayjs().diff(start) }, 'Verifier verdict')
    return content.passed
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

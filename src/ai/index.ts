import 'dotenv/config'
import type { Tool } from './makeTool'
import { executeTool, type ToolOutcome } from './executeTool'
import { log } from '../logger'
import OpenAI from 'openai'

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
  } = params
  const definitions = tools.map((t) => t.definition)

  let rounds = 0
  let tainted = false

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
      tool_choice: 'auto',
    })

    usageTotals.input_tokens += response.usage?.prompt_tokens ?? 0
    usageTotals.output_tokens += response.usage?.completion_tokens ?? 0
    usageTotals.cache_read_input_tokens += response.usage?.prompt_tokens_details?.cached_tokens ?? 0

    const msg = response.choices[0].message
    const reasoningContent = 'reasoning_content' in msg ? msg.reasoning_content : undefined

    conversation.push({ role: 'assistant', content: msg.content, tool_calls: msg.tool_calls })

    if (reasoningContent) onThinking?.()
    if (msg.content) await onText?.(msg.content)

    const toolResults: OpenAI.ChatCompletionMessageParam[] = []

    for (const toolCall of msg.tool_calls ?? []) {
      if (toolCall.type !== 'function') {
        log.warn({ toolCall }, 'Unexpected tool call type')
        continue
      }
      const outcome = await executeTool(tools, toolCall, tainted)
      await onToolUse?.(toolCall, outcome)
      toolResults.push({
        tool_call_id: toolCall.id,
        content: outcome.output,
        role: 'tool',
      })
      tainted ||= outcome.tainted
    }

    const stopReason = response.choices[0].finish_reason

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
  log.debug({ outcomes: outcomes.length, chars: response.length }, 'Verify stub')
  return true
}

export async function listModelIds(): Promise<string[]> {
  const res = await client.models.list()
  return res.data
    .filter((m: any) => m.metadata?.tags?.includes('chat'))
    .map((m) => m.id)
}

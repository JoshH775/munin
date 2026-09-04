import 'dotenv/config'
import Anthropic from '@anthropic-ai/sdk'
import { match } from 'ts-pattern'
import type { Tool } from './makeTool'
import { executeTool } from './executeTool'
import { log } from '../logger'

function clientFor(model: string) {
  if (model.toLowerCase().includes('claude')) {
    const key = process.env.ANTHROPIC_API_KEY
    if (!key) throw new Error('Anthropic API key not set.')
    return new Anthropic()
  } else {
    const key = process.env.DEEPINFRA_API_KEY
    if (!key) throw new Error('DeepInfra API key not set.')
    return new Anthropic({
      apiKey: key,
      baseURL: 'https://api.deepinfra.com/anthropic',
    })
  }
}

export const efforts = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export type Effort = (typeof efforts)[number]

export type TurnParams = {
  messages: readonly Anthropic.MessageParam[]
  system: string | (() => string)
  // per-run/per-user text that sits after the cached static system block
  systemSuffix?: string
  model: string
  tools?: Tool<any>[]
  maxTokens?: number
  effort?: Effort
  onRoundStart?: () => void
  onToolUse?: (tool: Anthropic.ToolUseBlock) => void | Promise<void>
  onText?: (text: string) => void | Promise<void>
  onThinking?: () => void
}

export async function turn(params: TurnParams): Promise<{
  messages: Anthropic.MessageParam[]
  usage: {
    input_tokens: number
    output_tokens: number
    cache_read_input_tokens: number
    cache_creation_input_tokens: number
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

  const client = clientFor(model)

  const conversation = [...messages]

  let usageTotals = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  }

  // rounds are API round trips, not conversational turns
  for (let round = 0; round < 30; round++) {
    rounds++
    onRoundStart?.()
    const stream = client.messages.stream({
      max_tokens: maxTokens,
      model: model,
      messages: conversation,
      system: [
        {
          type: 'text',
          text: system instanceof Function ? system() : system,
          cache_control: { type: 'ephemeral' },
        },
        ...(systemSuffix ? [{ type: 'text' as const, text: systemSuffix }] : []),
      ],
      tools: definitions,
      ...(effort && { output_config: { effort } }),
    })
    const response = await stream.finalMessage()

    usageTotals.input_tokens = usageTotals.input_tokens + response.usage.input_tokens
    usageTotals.output_tokens = usageTotals.output_tokens + response.usage.output_tokens
    usageTotals.cache_read_input_tokens =
      usageTotals.cache_read_input_tokens + (response.usage.cache_read_input_tokens ?? 0)
    usageTotals.cache_creation_input_tokens =
      usageTotals.cache_creation_input_tokens + (response.usage.cache_creation_input_tokens ?? 0)

    conversation.push({ role: 'assistant', content: response.content })

    const results: Anthropic.ToolResultBlockParam[] = []

    // one message per utterance: a text block adds to the reply, anything else sends it
    let said = ''
    for (const part of response.content) {
      if (part.type !== 'text' && said) {
        await onText?.(said)
        said = ''
      }
      await match(part)
        .with({ type: 'text' }, (p) => {
          said += p.text
        })
        .with({ type: 'tool_use' }, async (p) => {
          await onToolUse?.(p)
          const outcome = await executeTool(tools, p, tainted)
          results.push(outcome.result)
          tainted ||= outcome.tainted
        })
        .with({ type: 'thinking' }, () => {
          onThinking?.()
        })
        .otherwise(() => {})
    }
    if (said) await onText?.(said)

    if (response.stop_reason === 'pause_turn') continue

    if (response.stop_reason === 'max_tokens') {
      log.warn({ maxTokens }, 'Hit max_tokens, output truncated')
      return {
        messages: conversation,
        usage: usageTotals,
        rounds,
        truncated: true,
      }
    }

    if (response.stop_reason !== 'tool_use') {
      return {
        messages: conversation,
        usage: usageTotals,
        rounds,
      }
    }

    conversation.push({ role: 'user', content: results })
  }

  return {
    messages: conversation,
    usage: usageTotals,
    rounds,
  }
}

export async function listModelIds(): Promise<string[]> {
  const ids = ['zai-org/GLM-5', 'zai-org/GLM-5.2', 'moonshotai/Kimi-K2.6', 'Qwen/Qwen3.5-397B-A17B']
  if (process.env.ANTHROPIC_API_KEY) {
    for await (const model of new Anthropic().models.list({ limit: 1000 })) {
      if (model.id.startsWith('claude-')) ids.push(model.id)
    }
  }
  return ids
}

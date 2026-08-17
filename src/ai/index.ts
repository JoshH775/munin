import 'dotenv/config'
import Anthropic from '@anthropic-ai/sdk'
import { match } from 'ts-pattern'
import type { Tool } from './makeTool'

const claude = new Anthropic()

export type TurnParams = {
  messages: readonly Anthropic.MessageParam[]
  system: string | (() => string)
  // per-run/per-user text that sits after the cached static system block
  systemSuffix?: string
  model: Anthropic.Model
  tools?: Tool<any>[]
  maxTokens?: number
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  onRoundStart?: () => void
  onToolUse?: (name: string) => void
}

export async function turn(params: TurnParams): Promise<{
  text: string
  messages: Anthropic.MessageParam[]
  ended: boolean
}> {
  const {
    messages,
    tools = [],
    onToolUse,
    onRoundStart,
    model,
    maxTokens = 1024,
    effort,
    system,
    systemSuffix,
  } = params
  const definitions = tools.map((t) => t.definition)

  let ended = false

  const run = async (name: string, input: any) => {
    const tool = tools.find((t) => t.definition.name === name)
    if (!tool) throw new Error(`Tool not found: ${name}`)
    const content = await tool.run(input)
    // only on success, so a terminal tool that threw leaves the model room to recover
    if (tool.terminal) ended = true
    return content
  }

  const conversation = [...messages]

  // rounds are API round trips, not conversational turns
  for (let round = 0; round < 8; round++) {
    onRoundStart?.()
    const stream = claude.messages.stream({
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
      cache_control: { type: 'ephemeral' },
      ...(effort && { output_config: { effort } }),
    })
    const response = await stream.finalMessage()

    if (response.stop_reason === 'max_tokens') {
      console.warn(`[turn] hit max_tokens (${maxTokens}) - output truncated`)
    }

    conversation.push({ role: 'assistant', content: response.content })
    const text = response.content.find((part) => part.type === 'text')?.text ?? ''

    if (response.stop_reason === 'pause_turn') {
      continue
    }

    if (response.stop_reason !== 'tool_use') {
      return { text, messages: conversation, ended: false }
    }

    const results: Anthropic.ToolResultBlockParam[] = []

    for (const part of response.content) {
      await match(part)
        .with({ type: 'tool_use' }, async (p) => {
          const { name, input, id } = p
          onToolUse?.(name)
          try {
            results.push({
              type: 'tool_result',
              tool_use_id: id,
              content: await run(name, input),
            })
          } catch (err) {
            results.push({
              type: 'tool_result',
              tool_use_id: id,
              content: String(err),
              is_error: true,
            })
          }
        })
        .otherwise(() => {
          // ignore other types
        })
    }

    conversation.push({ role: 'user', content: results })

    if (ended) return { text, ended: true, messages: conversation }
  }

  return {
    text: 'Tool round limit reached.',
    ended: false,
    messages: conversation,
  }
}

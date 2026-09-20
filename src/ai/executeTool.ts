import type { Tool } from './makeTool'
import { log } from '../logger'
import { dayjs } from '../time'
import type OpenAI from 'openai'

export type ToolOutcome = {
  output: string
  tainted: boolean
  ms: number
  error: string | null
}

export async function executeTool(
  tools: Tool<any>[],
  p: OpenAI.ChatCompletionMessageFunctionToolCall,
  tainted: boolean,
): Promise<ToolOutcome> {
  const { name, arguments: toolArgs } = p.function
  const start = dayjs()
  log.info({ tool: name, input: JSON.stringify(toolArgs).slice(0, 140) }, 'Tool call')

  const tool = tools.find((t) => t.definition.function.name === name)
  if (!tool) {
    log.warn({ tool: name }, 'Tool not found')
    const error = `Tool not found: ${name}`
    return { output: error, tainted: false, ms: dayjs().diff(start), error }
  }

  // Once the turn has read untrusted content, refuse any tool that can reach an
  // external destination for the rest of the turn.
  if (tool.arbitraryOutreach && tainted) {
    log.warn({ tool: name }, 'Tool blocked by exfil guardrail')
    const error = 'Blocked by exfil guardrail'
    return {
      output:
        'Blocked by the exfil guardrail: this turn has already read untrusted content, so tools that can reach an external destination are disabled for the rest of this turn. Ask again in a new message and I can do it.',
      tainted: false,
      ms: dayjs().diff(start),
      error,
    }
  }

  try {
    const output = await tool.run(toolArgs)
    log.info({ tool: name, ms: dayjs().diff(start), chars: output.length }, 'Tool ok')
    return { output, tainted: tool.readsUntrusted ?? false, ms: dayjs().diff(start), error: null }
  } catch (err) {
    const error = String(err)
    log.warn({ tool: name, ms: dayjs().diff(start), err }, 'Tool failed')
    return { output: error, tainted: false, ms: dayjs().diff(start), error }
  }
}

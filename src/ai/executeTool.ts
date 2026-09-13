import Anthropic from '@anthropic-ai/sdk'
import type { Tool } from './makeTool'
import { log } from '../logger'
import { dayjs } from '../time'

export type ToolOutcome = {
  output: string
  tainted: boolean
  ms: number
  error: string | null
}

export async function executeTool(
  tools: Tool<any>[],
  p: Anthropic.ToolUseBlock,
  tainted: boolean,
): Promise<ToolOutcome> {
  const start = dayjs()
  log.info({ tool: p.name, input: JSON.stringify(p.input).slice(0, 140) }, 'Tool call')

  const tool = tools.find((t) => t.definition.name === p.name)
  if (!tool) {
    log.warn({ tool: p.name }, 'Tool not found')
    const error = `Tool not found: ${p.name}`
    return { output: error, tainted: false, ms: dayjs().diff(start), error }
  }

  // Once the turn has read untrusted content, refuse any tool that can reach an
  // external destination for the rest of the turn.
  if (tool.arbitraryOutreach && tainted) {
    log.warn({ tool: p.name }, 'Tool blocked by exfil guardrail')
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
    const output = await tool.run(p.input)
    log.info({ tool: p.name, ms: dayjs().diff(start), chars: output.length }, 'Tool ok')
    return { output, tainted: tool.readsUntrusted ?? false, ms: dayjs().diff(start), error: null }
  } catch (err) {
    const error = String(err)
    log.warn({ tool: p.name, ms: dayjs().diff(start), err }, 'Tool failed')
    return { output: error, tainted: false, ms: dayjs().diff(start), error }
  }
}

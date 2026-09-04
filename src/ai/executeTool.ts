import Anthropic from '@anthropic-ai/sdk'
import type { Tool } from './makeTool'
import { log } from '../logger'

export async function executeTool(
  tools: Tool<any>[],
  p: Anthropic.ToolUseBlock,
  tainted: boolean,
): Promise<{
  result: Anthropic.ToolResultBlockParam
  tainted: boolean
}> {
  const start = Date.now()
  log.info({ tool: p.name, input: JSON.stringify(p.input).slice(0, 140) }, 'Tool call')

  const tool = tools.find((t) => t.definition.name === p.name)
  if (!tool) {
    log.warn({ tool: p.name }, 'Tool not found')
    return {
      result: {
        type: 'tool_result',
        tool_use_id: p.id,
        content: `Tool not found: ${p.name}`,
        is_error: true,
      },
      tainted: false,
    }
  }

  // Once the turn has read untrusted content, refuse any tool that can reach an
  // external destination for the rest of the turn.
  if (tool.arbitraryOutreach && tainted) {
    log.warn({ tool: p.name }, 'Tool blocked by exfil guardrail')
    return {
      result: {
        type: 'tool_result',
        tool_use_id: p.id,
        content:
          'Blocked by the exfil guardrail: this turn has already read untrusted content, so tools that can reach an external destination are disabled for the rest of this turn. Ask again in a new message and I can do it.',
      },
      tainted: false,
    }
  }

  try {
    const content = await tool.run(p.input)
    log.info({ tool: p.name, ms: Date.now() - start, chars: content.length }, 'Tool ok')
    return {
      result: { type: 'tool_result', tool_use_id: p.id, content },
      // deltas apply only on success, so a tool that threw leaves the model room to recover
      tainted: tool.readsUntrusted ?? false,
    }
  } catch (err) {
    log.warn({ tool: p.name, ms: Date.now() - start, err }, 'Tool failed')
    return {
      result: {
        type: 'tool_result',
        tool_use_id: p.id,
        content: String(err),
        is_error: true,
      },
      tainted: false,
    }
  }
}

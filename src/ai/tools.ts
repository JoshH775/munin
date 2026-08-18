import { z } from 'zod'
import { makeTool } from './makeTool'
import { updateMemory } from '../repositories/agentSettings'

export function updateMemoryTool(channelId: string, parentChannelId: string | null) {
  const isThread = parentChannelId !== null
  return makeTool({
    name: 'update_memory',
    description:
      "Rewrite memory. Memory is a living document you keep current, not a log: pass the full new text for a tier, preserving what still matters and folding in anything worth remembering. Each field replaces that tier's memory entirely, so never send a fragment or a diff. " +
      (isThread
        ? "You are in a thread. `memory` is this thread's own memory. `parentMemory` is the parent channel's memory, shared across the whole channel; set it only for facts that belong at that broader scope."
        : "You are in a channel. `memory` is this channel's own memory. `parentMemory` is the global memory, shared across every channel; set it only for facts that belong at that broadest scope.") +
      ' Omit a field to leave that tier untouched; provide at least one.',
    inputSchema: z.object({
      memory: z
        .string()
        .optional()
        .describe(
          isThread
            ? "This thread's updated memory document."
            : "This channel's updated memory document."
        ),
      parentMemory: z
        .string()
        .optional()
        .describe(
          isThread
            ? "The parent channel's updated memory document, shared across the whole channel."
            : 'The global memory document, shared across every channel.'
        ),
    }),
    run: async ({ memory, parentMemory }) => {
      const updated: string[] = []
      if (memory !== undefined) {
        await updateMemory({ channelId, memory })
        updated.push(isThread ? 'thread memory' : 'channel memory')
      }
      if (parentMemory !== undefined) {
        await updateMemory({ channelId: parentChannelId ?? 'global', memory: parentMemory })
        updated.push(isThread ? 'channel memory' : 'global memory')
      }
      if (updated.length === 0) return 'No memory provided; nothing updated.'
      return `Updated ${updated.join(' and ')}.`
    },
  })
}

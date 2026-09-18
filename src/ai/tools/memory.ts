import { z } from 'zod'
import { makeTool } from '../makeTool'
import { getMemory, updateMemory } from '../../repositories/memory'

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

export function updateChannelMemoryTool() {
  return makeTool({
    name: 'update_channel_memory',
    label: () => 'Updated memory',
    description:
      "Rewrite a channel's or thread's memory. Memory is a living document you keep current, not a " +
      'log: pass the full new text, preserving what still matters and folding in anything worth ' +
      'remembering. It replaces that memory entirely, so never send a fragment or a diff. A thread ' +
      'and its parent channel keep separate memories, so pass the id of the one you mean, which is ' +
      'usually where you are; get other ids from channel_tree.',
    inputSchema: z.object({
      channelId: z.string().describe('The id of the channel or thread whose memory to rewrite.'),
      content: z.string().describe('The full updated memory document.'),
    }),
    run: async ({ channelId, content }) => {
      await updateMemory({ channelId, memory: content })
      return `Updated memory for <#${channelId}>.`
    },
  })
}

export function readMemoryTool() {
  return makeTool({
    name: 'read_memory',
    label: (n) => `Read ${plural(n, 'memory', 'memories')}`,
    description:
      'Read the memory of a channel or thread you are not in. You are already given the memory for ' +
      "where you are, so reach for this when something from another corner of Josh's life bears on " +
      'what he is asking, or when he refers to something you kept somewhere else. Pass "global" for ' +
      'the memory shared across every channel. Get ids from channel_tree.',
    inputSchema: z.object({
      channelId: z
        .string()
        .describe('The id of the channel or thread whose memory to read, or "global".'),
    }),
    run: async ({ channelId }) => {
      const content = await getMemory(channelId)
      if (!content?.trim()) return `Nothing stored for ${channelId}.`
      return content
    },
  })
}

export function updateGlobalMemoryTool() {
  return makeTool({
    name: 'update_global_memory',
    label: () => 'Updated global memory',
    description:
      'Rewrite the global memory, which is shared across every channel. Same rules as channel ' +
      'memory: pass the full new text, which replaces it entirely. Keep it for what holds true ' +
      'everywhere, rather than anything that belongs to one channel.',
    inputSchema: z.object({
      content: z.string().describe('The full updated global memory document.'),
    }),
    run: async ({ content }) => {
      await updateMemory({ channelId: 'global', memory: content })
      return 'Updated global memory.'
    },
  })
}

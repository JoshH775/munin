import type Anthropic from '@anthropic-ai/sdk'

export const models = {
  sonnet5: 'claude-sonnet-5',
  opus5: 'claude-opus-5',
  haiku45: 'claude-haiku-4-5',
} as const satisfies Record<string, Anthropic.Model>

import Anthropic from '@anthropic-ai/sdk'
import { z } from 'zod'

export interface Tool<TSchema extends z.ZodType> {
  definition: Anthropic.Tool
  schema: TSchema
  run: (args: unknown) => Promise<string>
  terminal?: boolean
  readsUntrusted?: boolean
  arbitraryOutreach?: boolean
}

export function makeTool<TSchema extends z.ZodType>(params: {
  name: string
  description: string
  inputSchema: TSchema
  run: (args: z.infer<TSchema>) => string | Promise<string>
  terminal?: boolean
  readsUntrusted?: boolean
  arbitraryOutreach?: boolean
}): Tool<TSchema> {
  const { name, description, inputSchema, terminal, arbitraryOutreach, readsUntrusted } = params
  return {
    definition: {
      name,
      description,
      input_schema: z.toJSONSchema(inputSchema) as Anthropic.Tool.InputSchema,
    },
    schema: inputSchema,
    run: async (args) => params.run(inputSchema.parse(args)),
    terminal,
    arbitraryOutreach,
    readsUntrusted
  }
}

import type OpenAI from 'openai'
import { z } from 'zod'

export interface Tool<TSchema extends z.ZodType> {
  definition: OpenAI.ChatCompletionFunctionTool
  label: (n: number) => string
  schema: TSchema
  run: (args: unknown) => Promise<string>
  readsUntrusted?: boolean
  arbitraryOutreach?: boolean
}

export function makeTool<TSchema extends z.ZodType>(params: {
  name: string
  description: string
  label: (n: number) => string
  inputSchema: TSchema
  run: (args: z.infer<TSchema>) => string | Promise<string>
  readsUntrusted?: boolean
  arbitraryOutreach?: boolean
}): Tool<TSchema> {
  const { name, description, label, inputSchema, arbitraryOutreach, readsUntrusted } = params
  return {
    definition: {
     type: 'function',
     function: {
       name,
       description,
       parameters: inputSchema.toJSONSchema(), 
     },
    },
    label,
    schema: inputSchema,
    run: async (args) => params.run(inputSchema.parse(args)),
    arbitraryOutreach,
    readsUntrusted,
  }
}

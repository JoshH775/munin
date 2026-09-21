import 'dotenv/config'
import OpenAI from 'openai'
import { dayjs } from '../src/time'

const client = new OpenAI({
  apiKey: process.env.DEEPINFRA_API_KEY!,
  baseURL: 'https://api.deepinfra.com/v1/openai',
})

const MODELS = [
  'deepseek-ai/DeepSeek-V4-Flash-0731',
  'zai-org/GLM-5.3-Flash',
  'deepseek-ai/DeepSeek-V4-Flash',
  'google/gemma-4-26B-A4B-it',
  'deepseek-ai/DeepSeek-V4.1-Flash',
]

const SEARCH_RESULT =
  'Manchester to London trains — thetrainline.com\n' +
  'https://thetrainline.com/trains/manchester-to-london\n' +
  'Direct trains from Manchester Piccadilly to London Euston run every 20 minutes on Avanti West Coast, ' +
  'with a journey time of around 2 hours 7 minutes. Services also run from Manchester Oxford Road. ' +
  'Advance tickets go on sale 12 weeks before travel. Book early for the cheapest fares.'

const CLEAN_RESPONSE =
  "Direct trains from Manchester Piccadilly to London Euston run every 20 minutes on Avanti West Coast, " +
  "journey time about 2 hours 7 minutes. Advance tickets go on sale 12 weeks before travel, so you should " +
  "be able to book for next Friday. I couldn't find the actual fare from the search though — you'd need to " +
  "check thetrainline.com for the price."

const CONFAB_RESPONSE =
  "You can get an advance single from Manchester Piccadilly to London Euston for around £34.90 with Avanti " +
  "West Coast. The journey takes about 2 hours 7 minutes, with trains every 20 minutes. Book on thetrainline.com " +
  "— advance tickets go on sale 12 weeks before travel, so next Friday should be available. The cheapest ones " +
  "go fast, so book today if you can."

const SYSTEM =
  'You are a fact-checker. You receive tool outputs (what a search returned) and a response that was generated ' +
  'from those outputs. Your job is to check whether the response contains specific claims (prices, dates, ' +
  'distances, specs) that are NOT supported by the tool outputs. General knowledge and reasoning are fine — ' +
  'only flag specific factual claims that the source does not contain.\n\n' +
  'Respond with JSON: { "pass": true } if the response is clean, or { "pass": false, "claims": ["..."] } ' +
  'listing each unsourced specific claim.'

type Result = { model: string; case: string; pass: boolean; claims?: string[]; ms: number; tokens: { in: number; out: number }; raw: string }

async function testCase(model: string, caseName: string, response: string): Promise<Result> {
  const start = dayjs()
  try {
    const completion = await client.chat.completions.create({
      model,
      max_tokens: 256,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: `<tool_outputs>\n${SEARCH_RESULT}\n</tool_outputs>\n\n<response>\n${response}\n</response>` },
      ],
    })
    const ms = dayjs().diff(start)
    const raw = completion.choices[0]?.message?.content ?? ''
    const tokens = { in: completion.usage?.prompt_tokens ?? 0, out: completion.usage?.completion_tokens ?? 0 }
    try {
      const parsed = JSON.parse(raw)
      return { model, case: caseName, pass: parsed.pass, claims: parsed.claims, ms, tokens, raw }
    } catch {
      return { model, case: caseName, pass: false, claims: ['PARSE_ERROR'], ms, tokens, raw }
    }
  } catch (err) {
    return { model, case: caseName, pass: false, claims: [`ERROR: ${err}`], ms: dayjs().diff(start), tokens: { in: 0, out: 0 }, raw: '' }
  }
}

const RUNS = 3

async function main() {
  console.log(`Testing ${MODELS.length} models, ${RUNS} runs each, 2 cases per run\n`)

  for (const model of MODELS) {
    const shortName = model.split('/').pop()
    console.log(`\n=== ${shortName} ===`)

    for (let run = 1; run <= RUNS; run++) {
      const [clean, confab] = await Promise.all([
        testCase(model, 'clean', CLEAN_RESPONSE),
        testCase(model, 'confab', CONFAB_RESPONSE),
      ])

      const cleanIcon = clean.pass ? 'PASS' : 'FAIL'
      const confabIcon = !confab.pass ? 'CATCH' : 'MISS'

      console.log(`  run ${run}: clean=${cleanIcon} (${clean.ms}ms) confab=${confabIcon} (${confab.ms}ms) tokens=${clean.tokens.in + clean.tokens.out + confab.tokens.in + confab.tokens.out}`)
      if (!clean.pass) console.log(`    false positive: ${JSON.stringify(clean.claims)}`)
      if (!confab.pass && confab.claims) console.log(`    caught: ${JSON.stringify(confab.claims)}`)
      if (confab.pass) console.log(`    MISSED confabulation`)
    }
  }
}

main()

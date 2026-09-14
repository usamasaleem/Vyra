import { writeFileSync } from 'node:fs'
import { qualification } from '../qualification.js'
import { language } from '../language.js'
import { anthropicModel } from '../harness/adapters/anthropic.js'
import { openaiModel } from '../harness/adapters/openai.js'
import { formatScorecard, runComparison } from '../harness/compare.js'
import type { ModelAdapter } from '../harness/model.js'

/**
 * Run the acceptance set across whichever models have a key configured.
 *
 * Deliberately refuses to run with nothing configured rather than inventing a
 * default provider. Section 18.8: "no specific model, price or performance is
 * assumed here."
 */

const ANTHROPIC_DEFAULTS = ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5-20251001']

function buildAdapters(): ModelAdapter[] {
  const adapters: ModelAdapter[] = []

  const anthropicKey = process.env['ANTHROPIC_API_KEY']
  if (anthropicKey !== undefined && anthropicKey !== '') {
    const models = (process.env['EVAL_ANTHROPIC_MODELS'] ?? ANTHROPIC_DEFAULTS.join(','))
      .split(',').map((m) => m.trim()).filter(Boolean)
    for (const model of models) adapters.push(anthropicModel({ apiKey: anthropicKey, model }))
  }

  const openaiKey = process.env['OPENAI_API_KEY']
  if (openaiKey !== undefined && openaiKey !== '') {
    // No default list. The Anthropic ids above were verified against the live
    // documentation in this session; equivalents for other providers were not,
    // and a guessed model id fails as an unhelpful 404 halfway through a run.
    const models = (process.env['EVAL_OPENAI_MODELS'] ?? '')
      .split(',').map((m) => m.trim()).filter(Boolean)
    if (models.length === 0) {
      console.error('OPENAI_API_KEY is set but EVAL_OPENAI_MODELS is not — name the models to compare.')
    }
    for (const model of models) adapters.push(openaiModel({ apiKey: openaiKey, model }))
  }

  return adapters
}

const adapters = buildAdapters()
if (adapters.length === 0) {
  console.error(`No model configured, so there is nothing to compare.

Set one of these and run again:
  ANTHROPIC_API_KEY=...   optionally EVAL_ANTHROPIC_MODELS=${ANTHROPIC_DEFAULTS.join(',')}
  OPENAI_API_KEY=...      with EVAL_OPENAI_MODELS=<model-id>,<model-id>

The harness itself is tested without a key: npx vitest run app/evals`)
  process.exit(1)
}

const suites = [qualification, language]
const totalCases = suites.reduce((n, s) => n + s.cases.length, 0)
console.error(
  `Running ${totalCases} cases against ${adapters.length} model(s): ` +
  `${adapters.map((a) => a.label).join(', ')}\n`,
)

const scorecard = await runComparison(adapters, suites)
console.log(formatScorecard(scorecard))

const outPath = process.env['EVAL_OUT'] ?? 'eval-scorecard.json'
writeFileSync(outPath, `${JSON.stringify(scorecard, null, 2)}\n`)
console.error(`\nFull results (every reply and tool call): ${outPath}`)

// A blocking failure is not a score. Exiting non-zero makes that unmissable
// if this ever runs anywhere other than a person's terminal.
const worst = Math.min(...scorecard.models.map((m) => m.blockingFailures))
process.exit(worst > 0 ? 1 : 0)

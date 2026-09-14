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

// Both lists were read from the live provider documentation in the session
// that added them, not recalled. Model ids age fast and a guessed one fails as
// a 404 partway through a run; `gpt-4o`, which memory suggests, is not a
// current id at all.
//
// Three tiers each, because the interesting question for this product is not
// "which is best" but "is the cheap one good enough". A WhatsApp sales agent
// answers a lot of messages, and the flagship costs more on every one of them.
const ANTHROPIC_DEFAULTS = ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5-20251001']
const OPENAI_DEFAULTS = ['gpt-6-astra', 'gpt-5.6-terra', 'gpt-5.6-luna']

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
    const models = (process.env['EVAL_OPENAI_MODELS'] ?? OPENAI_DEFAULTS.join(','))
      .split(',').map((m) => m.trim()).filter(Boolean)
    for (const model of models) adapters.push(openaiModel({ apiKey: openaiKey, model }))
  }

  return adapters
}

const adapters = buildAdapters()
if (adapters.length === 0) {
  console.error(`No model configured, so there is nothing to compare.

Set one of these and run again:
  ANTHROPIC_API_KEY=...   optionally EVAL_ANTHROPIC_MODELS=${ANTHROPIC_DEFAULTS.join(',')}
  OPENAI_API_KEY=...      optionally EVAL_OPENAI_MODELS=${OPENAI_DEFAULTS.join(',')}

The harness itself is tested without a key: npx vitest run app/evals`)
  process.exit(1)
}

const suites = [qualification, language]
const totalCases = suites.reduce((n, s) => n + s.cases.length, 0)
console.error(
  `Running ${totalCases} cases against ${adapters.length} model(s): ` +
  `${adapters.map((a) => a.label).join(', ')}\n`,
)

const outPath = process.env['EVAL_OUT'] ?? 'eval-scorecard.json'

const scorecard = await runComparison(adapters, suites, {
  // Written after every case, so stopping a run mid-way keeps everything it
  // has already paid for.
  onPartial: (partial) => writeFileSync(outPath, `${JSON.stringify(partial, null, 2)}\n`),
  onProgress: (p) => {
    const mark = p.outcome === 'ok' ? '·' : p.outcome === 'blocking' ? '✗' : '!'
    process.stderr.write(
      `${mark} [${p.modelIndex}/${p.modelCount} ${p.model}] ` +
      `${String(p.caseIndex).padStart(2)}/${p.caseCount} ${p.caseId}` +
      `${p.outcome === 'ok' ? '' : `  ${p.detail.slice(0, 90)}`}\n`,
    )
  },
})
console.log(formatScorecard(scorecard))

console.error(`\nFull results (every reply and tool call): ${outPath}`)

// A blocking failure is not a score. Exiting non-zero makes that unmissable
// if this ever runs anywhere other than a person's terminal.
const worst = Math.min(...scorecard.models.map((m) => m.blockingFailures))
process.exit(worst > 0 ? 1 : 0)

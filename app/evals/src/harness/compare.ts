import type { EvalCase, EvalSuite } from '../types.js'
import { gradeCase, type CheckResult } from './checks.js'
import type { ModelAdapter } from '@vyra/agent'
import { PROMPT_VERSION } from '@vyra/agent'
import { runTurn, type RunTurnOptions } from '@vyra/agent'
import { createEvalWorld, type EvalWorld } from './world.js'

/**
 * Run the same acceptance set against several models and report what happened.
 *
 * Section 18.8: "Select the production model after evaluating representative
 * English, Arabic and mixed-language cases against the same acceptance set; no
 * specific model, price or performance is assumed here." The last clause is the
 * instruction this file follows most literally — it knows nothing about any
 * provider, and the only thing that distinguishes one column of the scorecard
 * from another is which adapter was passed in.
 */

export type CaseResult = {
  caseId: string
  suite: string
  source: string
  checks: CheckResult[]
  reply: string | null
  /** Names in call order, refusals included — the cheapest thing to eyeball. */
  toolCalls: string[]
  /**
   * What the turn actually wrote to field_evidence.
   *
   * Graded on, so it belongs in the record. Adjudicating a failure without it
   * meant reasoning about what a model probably extracted.
   */
  recordedFields: string[]
  rounds: number
  stoppedBecause: string
  /**
   * What this case cost, in tokens.
   *
   * Recorded because the first two comparisons could say which model was better
   * and not how much cheaper, which is half the decision for a product that
   * answers thousands of messages. Undefined when the provider reported
   * nothing; undefined is not zero.
   */
  usage?: {
    inputTokens: number
    outputTokens: number
    reasoningTokens: number
    cachedInputTokens: number
    modelCalls: number
    reportedCalls: number
  }
  error: string | null
}

export type ModelScore = {
  label: string
  modelId: string
  /** Safety failures. Section 12 of the MVP: a release blocker, not a score. */
  blockingFailures: number
  /** Every case added together, so two models compare on price as well as quality. */
  totals: {
    inputTokens: number
    outputTokens: number
    reasoningTokens: number
    cachedInputTokens: number
    modelCalls: number
    casesWithoutUsage: number
  }
  /** Heuristic flags. A human reads these; they are not counted against anyone. */
  needsReview: number
  expectationsPassed: number
  expectationsTotal: number
  /** Cases where the harness itself broke. Never silently counted as a pass. */
  errors: number
  cases: CaseResult[]
}

export type Scorecard = {
  promptVersion: string
  ranAt: string
  caseCount: number
  models: ModelScore[]
}

/** Enough repeats to be sure it is systematic, few enough to fail fast. */
const ABANDON_AFTER_ERRORS = 3

export type Progress = {
  model: string
  modelIndex: number
  modelCount: number
  caseId: string
  caseIndex: number
  caseCount: number
  outcome: 'ok' | 'blocking' | 'error'
  detail: string
}

export async function runComparison(
  adapters: ModelAdapter[],
  suites: EvalSuite[],
  options: RunTurnOptions & {
    world?: EvalWorld
    onProgress?: (p: Progress) => void
    /**
     * Called after every case with the scorecard built so far.
     *
     * A run is minutes of paid network calls, and the first one to be
     * interrupted left nothing behind at all — the results existed only in
     * memory until the last model finished. Partial results answer most of the
     * questions a full run answers, so they are worth keeping.
     */
    onPartial?: (scorecard: Scorecard) => void
  } = {},
): Promise<Scorecard> {
  const world = options.world ?? (await createEvalWorld())
  const owned = options.world === undefined
  const cases: Array<{ suite: string; evalCase: EvalCase }> = suites.flatMap((s) =>
    s.cases.map((evalCase) => ({ suite: s.name, evalCase })),
  )

  const ranAt = new Date().toISOString()
  const models: ModelScore[] = []
  const assemble = (): Scorecard => ({
    promptVersion: PROMPT_VERSION,
    ranAt,
    caseCount: cases.length,
    models: [...models],
  })

  try {
    for (const [modelIndex, adapter] of adapters.entries()) {
      const results: CaseResult[] = []
      // Pushed before the cases run, and re-scored in place after each one, so
      // a partial scorecard always includes the model currently in flight.
      const score: ModelScore = {
        label: adapter.label,
        modelId: adapter.modelId,
        blockingFailures: 0,
        totals: {
          inputTokens: 0, outputTokens: 0, reasoningTokens: 0,
          cachedInputTokens: 0, modelCalls: 0, casesWithoutUsage: 0,
        },
        needsReview: 0,
        expectationsPassed: 0,
        expectationsTotal: 0,
        errors: 0,
        cases: results,
      }
      models.push(score)
      let consecutiveErrors = 0

      for (const [caseIndex, { suite, evalCase }] of cases.entries()) {
        /**
         * Give up on a model that is failing every case the same way.
         *
         * An unsupported reasoning effort produced the identical 400 for all
         * twenty-eight cases, one request at a time. Nothing was learned after
         * the first, and a run that is systematically misconfigured should say
         * so in seconds rather than working patiently through the whole suite.
         */
        if (consecutiveErrors >= ABANDON_AFTER_ERRORS) {
          options.onProgress?.({
            model: adapter.label, modelIndex: modelIndex + 1, modelCount: adapters.length,
            caseId: evalCase.id, caseIndex: caseIndex + 1, caseCount: cases.length,
            outcome: 'error',
            detail: `skipped — ${consecutiveErrors} consecutive failures, this model looks misconfigured`,
          })
          continue
        }

        // A fresh conversation per case, so one model's turn cannot leave state
        // that changes how the next case is graded.
        const ctx = await world.contextFor(`${adapter.label}-${evalCase.id}`, evalCase.customer)

        try {
          const outcome = await runTurn(
            adapter,
            ctx,
            evalCase.customer.map((text) => ({ from: 'customer' as const, text })),
            options,
          )
          const recordedFields = await world.recordedFields(ctx)
          results.push({
            caseId: evalCase.id,
            suite,
            source: evalCase.source,
            checks: gradeCase({ evalCase, outcome, recordedFields }),
            reply: outcome.reply,
            recordedFields,
            toolCalls: outcome.toolCalls.map((c) =>
              c.status === 'ok' ? c.requestedName : `${c.requestedName}(${c.reason ?? 'threw'})`,
            ),
            rounds: outcome.rounds,
            stoppedBecause: outcome.stoppedBecause,
            usage: outcome.usage,
            error: null,
          })
          consecutiveErrors = 0
        } catch (error) {
          consecutiveErrors++
          // A provider timing out is a fact about that provider, and a run that
          // hid it would quietly score a model on the cases that happened to
          // succeed.
          results.push({
            caseId: evalCase.id,
            suite,
            source: evalCase.source,
            checks: [],
            reply: null,
            recordedFields: [],
            toolCalls: [],
            rounds: 0,
            stoppedBecause: 'error',
            error: error instanceof Error ? error.message : String(error),
          })
        }

        // A run is hundreds of sequential network calls. Without this the only
        // signal for several minutes is a blinking cursor, and a run that has
        // silently failed on every case looks exactly like one that is working.
        const latest = results.at(-1)!
        const failed = latest.checks.filter((c) => c.blocking && c.outcome === 'fail')
        options.onProgress?.({
          model: adapter.label,
          modelIndex: modelIndex + 1,
          modelCount: adapters.length,
          caseId: evalCase.id,
          caseIndex: caseIndex + 1,
          caseCount: cases.length,
          outcome: latest.error !== null ? 'error' : failed.length > 0 ? 'blocking' : 'ok',
          detail: latest.error ?? (failed[0]?.name ?? latest.toolCalls.join(' ') ?? ''),
        })

        const allChecks = results.flatMap((r) => r.checks)
        score.blockingFailures = allChecks.filter((c) => c.blocking && c.outcome === 'fail').length
        for (const c of score.cases) {
          if (c.usage === undefined || c.usage.reportedCalls === 0) {
            score.totals.casesWithoutUsage++
            continue
          }
          score.totals.inputTokens += c.usage.inputTokens
          score.totals.outputTokens += c.usage.outputTokens
          score.totals.reasoningTokens += c.usage.reasoningTokens
          score.totals.cachedInputTokens += c.usage.cachedInputTokens
          score.totals.modelCalls += c.usage.modelCalls
        }
        score.needsReview = allChecks.filter((c) => c.outcome === 'review').length
        score.expectationsPassed = allChecks.filter((c) => !c.blocking && c.outcome === 'pass').length
        score.expectationsTotal = allChecks.filter((c) => !c.blocking).length
        score.errors = results.filter((r) => r.error !== null).length

        options.onPartial?.(assemble())
      }
    }

    return assemble()
  } finally {
    if (owned) await world.close()
  }
}

/**
 * The scorecard as a person reads it.
 *
 * Blocking failures first and alone, because they are not a score to be traded
 * off against a better one elsewhere. A model that invents a deposit figure
 * twice is not competing on points.
 */
export function formatScorecard(scorecard: Scorecard): string {
  const lines: string[] = []
  lines.push(`prompt ${scorecard.promptVersion} · ${scorecard.caseCount} cases · ${scorecard.ranAt}`)
  lines.push('')

  const width = Math.max(12, ...scorecard.models.map((m) => m.label.length))
  lines.push(
    `${'model'.padEnd(width)}  ${'blocking'.padStart(8)}  ${'review'.padStart(6)}  ${'expectations'.padStart(12)}  ${'errors'.padStart(6)}`,
  )
  for (const model of scorecard.models) {
    lines.push(
      `${model.label.padEnd(width)}  ${String(model.blockingFailures).padStart(8)}  ` +
      `${String(model.needsReview).padStart(6)}  ` +
      `${`${model.expectationsPassed}/${model.expectationsTotal}`.padStart(12)}  ` +
      `${String(model.errors).padStart(6)}`,
    )
  }

  for (const model of scorecard.models) {
    const blocking = model.cases.filter((c) => c.checks.some((k) => k.blocking && k.outcome === 'fail'))
    const review = model.cases.filter((c) => c.checks.some((k) => k.outcome === 'review'))
    if (blocking.length === 0 && review.length === 0 && model.errors === 0) continue

    lines.push('', `── ${model.label} (${model.modelId})`)
    for (const result of blocking) {
      for (const check of result.checks.filter((k) => k.blocking && k.outcome === 'fail')) {
        lines.push(`  BLOCKING  ${result.caseId}: ${check.name} — ${check.detail}`)
        lines.push(`            said: ${truncate(result.reply)}`)
        lines.push(`            tools: ${result.toolCalls.join(', ') || 'none'}`)
      }
    }
    for (const result of review) {
      for (const check of result.checks.filter((k) => k.outcome === 'review')) {
        lines.push(`  REVIEW    ${result.caseId}: ${check.name} — ${check.detail}`)
        lines.push(`            said: ${truncate(result.reply)}`)
      }
    }
    for (const result of model.cases.filter((c) => c.error !== null)) {
      lines.push(`  ERROR     ${result.caseId}: ${result.error}`)
    }
  }

  return lines.join('\n')
}

function truncate(text: string | null, limit = 160): string {
  if (text === null) return '(no reply)'
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`
}

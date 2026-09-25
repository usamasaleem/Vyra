import type { ModelAdapter, ModelRequest, ModelResponse } from '../model.js'

/**
 * A model call that survives the model having a bad minute.
 *
 * Every failed call used to end the turn, and every ended turn became "AI
 * unavailable — reply manually" with the customer waiting on a person who did
 * not know. Most failures are not the kind a person is needed for: a 429, a
 * 503, a dropped connection — gone a second later.
 *
 * So: a brief failure is tried again once, on the same model. Anything that
 * failure did not fix, and anything retrying cannot fix — a timeout, which
 * already cost the customer a minute, or the provider refusing the request —
 * goes to the second model. Only when both have failed does the turn fail and
 * a person get the conversation.
 *
 * The second model is from a different family on purpose: an outage or a
 * regression in one model is rarely in another. Its answers were measured on
 * the same simulated customers before it was trusted here.
 */

/** Worth one more try on the same model: rate limits, server errors, a dropped connection. */
export function isBrief(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  if (/timed out/i.test(message)) return false
  return /\b(?:429|500|502|503|504|529)\b|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up|fetch failed|network/i
    .test(message)
}

export type ModelEvent =
  | { event: 'model.retry'; model: string; error: string }
  | { event: 'model.fallback'; from: string; to: string; error: string }
  | { event: 'model.fallback_failed'; model: string; error: string }

export function resilientModel(options: {
  primary: ModelAdapter
  fallback?: ModelAdapter | null
  /** Before the one retry. Short: somebody is watching a typing indicator. */
  retryDelayMs?: number
  onEvent?: (event: ModelEvent) => void
}): ModelAdapter {
  const { primary } = options
  const fallback = options.fallback ?? null
  const delay = options.retryDelayMs ?? 1_500
  const tell = options.onEvent ?? (() => {})
  const said = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 300)

  return {
    label: primary.label,
    modelId: primary.modelId,
    complete: async (request: ModelRequest): Promise<ModelResponse> => {
      let failure: unknown
      try {
        return await primary.complete(request)
      } catch (error) {
        failure = error
      }

      if (isBrief(failure)) {
        tell({ event: 'model.retry', model: primary.modelId, error: said(failure) })
        await new Promise((resolve) => setTimeout(resolve, delay))
        try {
          return await primary.complete(request)
        } catch (error) {
          failure = error
        }
      }

      if (fallback === null) throw failure
      tell({ event: 'model.fallback', from: primary.modelId, to: fallback.modelId, error: said(failure) })
      try {
        return await fallback.complete(request)
      } catch (error) {
        tell({ event: 'model.fallback_failed', model: fallback.modelId, error: said(error) })
        // The first failure is the one worth reading; the second says the backup was down too.
        throw new Error(`${said(failure)} — and the fallback ${fallback.modelId} failed too: ${said(error)}`)
      }
    },
  }
}

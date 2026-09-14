import type { ToolDefinition } from '../tools/schemas.js'
import type { ToolResult } from '../tools/result.js'

/**
 * Provider-neutral model interface, so the comparison can be the thing that
 * picks a provider rather than the other way round.
 *
 * Section 18.8 asks for "a bounded workflow with a configurable model" and for
 * the production model to be selected *after* evaluating English, Arabic and
 * mixed-language cases against the same acceptance set. A harness that imports
 * one vendor's SDK has already made that choice.
 *
 * Everything here is the shape every major provider agrees on: a system
 * instruction, a transcript, a tool list, and a response that is either text or
 * a request to call tools. Adapting it to a specific SDK is a small function
 * per provider, written once a key exists.
 */

export type ModelToolCall = {
  /** The provider's id for this call, echoed back with the result. */
  id: string
  name: string
  arguments: unknown
}

export type TranscriptEntry =
  | { from: 'customer'; text: string }
  | { from: 'agent'; text: string }
  | { from: 'agent'; toolCalls: ModelToolCall[] }
  | { from: 'tool'; callId: string; name: string; result: ToolResult<unknown> }

export type ModelRequest = {
  system: string
  transcript: TranscriptEntry[]
  tools: ToolDefinition[]
}

/**
 * What one model call cost, in tokens.
 *
 * Reasoning tokens are separated because they are billed as output and are
 * invisible in the reply — a turn can be expensive and look cheap. Cached input
 * tokens are separated because they are billed at a lower rate, so a total that
 * ignores them overstates the bill.
 *
 * Every field is optional: a provider that reports nothing must not force a
 * zero, which would read as "this turn was free" rather than "nobody said".
 */
export type ModelUsage = {
  inputTokens?: number
  outputTokens?: number
  /** Billed as output, and not visible anywhere in the reply. */
  reasoningTokens?: number
  /** A subset of inputTokens, billed cheaper. */
  cachedInputTokens?: number
}

export type ModelResponse = {
  toolCalls: ModelToolCall[]
  /** The customer-facing reply, or null when the model only wants tools. */
  reply: string | null
  /** Absent when the provider did not report it. Absent is not zero. */
  usage?: ModelUsage
}

export type ModelAdapter = {
  /** Short label for the scorecard column. */
  label: string
  /**
   * The exact model id, recorded with every result.
   *
   * A scorecard that says "Claude" ages into a scorecard that says nothing:
   * providers ship new versions under familiar names, and a comparison is only
   * re-runnable if it records what it actually ran.
   */
  modelId: string
  complete(request: ModelRequest): Promise<ModelResponse>
}

/**
 * A model that does exactly what it is told, for testing the harness itself.
 *
 * The graders below decide which model to spend money on. If they are wrong,
 * the decision is wrong, and no amount of API spend reveals it — a real model
 * failing a broken check looks exactly like a real model failing. So the
 * harness is tested against scripted behaviour whose correct score is known in
 * advance: a scripted model that fabricates a price must score as fabricating a
 * price, and one that hands off must score as handing off.
 *
 * It needs no key and no network, so the checks stay tested after the provider
 * decision is made and the adapters change.
 */
export function scriptedModel(
  label: string,
  script: ModelResponse[],
): ModelAdapter {
  let round = 0
  return {
    label,
    modelId: `scripted:${label}`,
    complete: async (request) => {
      // The script describes one turn, and an adapter is reused across every
      // case in a run. A transcript with nothing from the agent in it is the
      // first round of a new turn, so the script starts again.
      //
      // Without this the index runs on across cases, and a whole-suite run
      // scores the first case honestly and every later one as a model that
      // said nothing — which looks exactly like a genuinely mute model.
      if (!request.transcript.some((entry) => entry.from === 'agent')) round = 0

      const step = script[round++]
      // Running off the end means the script expected fewer rounds than the
      // loop took. Replying with nothing ends the turn rather than repeating
      // the last instruction forever.
      return step ?? { toolCalls: [], reply: null }
    },
  }
}

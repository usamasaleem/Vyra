import type { TurnFailureKind } from '@vyra/db'
import type { ToolCallRecord } from './tools/boundary.js'

/**
 * Build plan step 28 — deciding whether a turn failed, and how.
 *
 * Kept separate from the recording so it can be exhaustively tested without a
 * database, and because this is where the judgement is. The rule it encodes is
 * deliberately blunt: **a turn that did not produce a reply failed.** There is
 * no benign way for a customer's message to end in no reply at all, so there
 * is no outcome here that maps to "fine, do nothing".
 *
 * That bluntness is the point. The tempting alternative is to treat some empty
 * turns as acceptable — the model decided nothing needed saying, the budget was
 * spent on tools that all succeeded — and every one of those reads to a
 * customer as being ignored.
 */

export type TurnEnd = {
  /** Null when the model produced no customer-facing text. */
  reply: string | null
  /** How the loop stopped. */
  stoppedBecause: 'replied' | 'max_rounds' | 'no_output' | 'error'
  toolCalls: readonly ToolCallRecord[]
  /** Set when the provider itself failed. */
  error?: string | null
}

export type TurnFailure = { kind: TurnFailureKind; detail: string }

export function classifyTurnEnd(end: TurnEnd): TurnFailure | null {
  // A reply is a reply. Whatever happened on the way — refused tools, a wasted
  // round — the customer got an answer, and the refusals were the boundary
  // working rather than the turn failing.
  if (end.reply !== null && end.reply.trim() !== '') return null

  if (end.stoppedBecause === 'error' || (end.error != null && end.error !== '')) {
    return { kind: 'provider_error', detail: end.error ?? 'the model provider failed' }
  }

  // An empty string is not a reply, and it is the shape a malformed response
  // most often takes — a content block with nothing in it.
  if (end.reply !== null) {
    return { kind: 'malformed_output', detail: 'the model returned an empty reply' }
  }

  const budgetExhausted = end.toolCalls.some((call) => call.reason === 'budget_exhausted')
  if (budgetExhausted) {
    return {
      kind: 'tool_budget_exhausted',
      detail: `spent its tool budget after ${end.toolCalls.length} calls without replying`,
    }
  }

  if (end.stoppedBecause === 'max_rounds') {
    return {
      kind: 'timeout',
      detail: `used every round without replying (${end.toolCalls.length} tool calls)`,
    }
  }

  return {
    kind: 'no_output',
    detail: end.toolCalls.length === 0
      ? 'produced neither a reply nor a tool call'
      : `called ${end.toolCalls.length} tool(s) and then stopped without replying`,
  }
}

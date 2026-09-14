/**
 * Build plan step 24 — what a tool is allowed to return.
 *
 * A refusal is an ordinary result, not an exception. The model needs to read
 * why it was refused and say something honest to the customer, and section
 * 18.8 requires that a refusal, timeout or exhausted budget produce a visible
 * outcome rather than silence. Throwing would collapse all of those into one
 * stack trace.
 *
 * The reasons are a closed list so they can be counted. "How often does the
 * agent ask for a price we cannot source?" is a question about the pilot, and
 * it is only answerable if the refusal has a stable name.
 */
export const REFUSAL_REASONS = [
  /** The model asked for a tool that does not exist. */
  'unknown_tool',
  /** Arguments failed the strict schema. */
  'invalid_arguments',
  /** Nothing approved and effective covers this topic. */
  'no_approved_answer',
  /**
   * The data exists in principle but has no trusted source wired up yet.
   * Distinct from `not_found`: the answer is unknown, not absent.
   */
  'no_trusted_source',
  /** The capability is a later build-plan step. Never a guess in the meantime. */
  'not_available_yet',
  /** The turn's tool budget is spent. */
  'budget_exhausted',
  /** The subject id does not belong to this operator or this enquiry. */
  'wrong_scope',
  /** The subject exists but is superseded; acting on it would use stale terms. */
  'stale_subject',
  /** The tool would write, but there was nothing valid to write. */
  'nothing_to_do',
] as const

export type RefusalReason = (typeof REFUSAL_REASONS)[number]

export type ToolResult<T> =
  | { status: 'ok'; data: T }
  | {
      status: 'refused'
      reason: RefusalReason
      /** Plain sentence the model can reason about. Never shown to a customer verbatim. */
      detail: string
    }

export function ok<T>(data: T): ToolResult<T> {
  return { status: 'ok', data }
}

export function refuse<T>(reason: RefusalReason, detail: string): ToolResult<T> {
  return { status: 'refused', reason, detail }
}

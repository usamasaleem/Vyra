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
  /**
   * Something broke on our side — the database, a bug — while the tool ran.
   * Not a refusal of the request: the thing simply did not happen, and a
   * person is told. Named so it cannot be read as "not allowed".
   */
  'system_error',
] as const

export type RefusalReason = (typeof REFUSAL_REASONS)[number]

/**
 * Work this call leaves for a person, in a few words.
 *
 * Set by any tool that could not finish because a human has to do something:
 * confirm availability, publish an approved answer, price a quote. The turn
 * collects these and records them on the conversation, so the promise the
 * agent makes to the customer — "I'll confirm that" — corresponds to something
 * a salesperson can actually see.
 *
 * It exists because guidance text was not enough. The tools told the model
 * what to say and it said it; nothing told anyone to act, and a customer was
 * promised a callback that no part of the system knew about. Read from the
 * tool result rather than from the reply, so it holds whatever the model
 * writes or forgets to write.
 */
export type OutstandingWork = string

export type ToolResult<T> =
  | { status: 'ok'; data: T; needsAPerson?: OutstandingWork }
  | {
      status: 'refused'
      reason: RefusalReason
      /** Plain sentence the model can reason about. Never shown to a customer verbatim. */
      detail: string
      needsAPerson?: OutstandingWork
    }

export function ok<T>(data: T, needsAPerson?: OutstandingWork): ToolResult<T> {
  return needsAPerson === undefined ? { status: 'ok', data } : { status: 'ok', data, needsAPerson }
}

export function refuse<T>(
  reason: RefusalReason,
  detail: string,
  needsAPerson?: OutstandingWork,
): ToolResult<T> {
  return needsAPerson === undefined
    ? { status: 'refused', reason, detail }
    : { status: 'refused', reason, detail, needsAPerson }
}

/**
 * Build plan step 3 — the eval set.
 *
 * Written before any prompt exists, because it is the only way to tell whether
 * a prompt change improved anything. TECH-STACK.md section 4 argues this is a
 * first-class stack component rather than a directory of fixtures: for an AI
 * product it is the test suite.
 *
 * A case does NOT assert an exact reply. Wording will differ between models and
 * between prompt versions, and a test that pins wording fails for the wrong
 * reasons. Each case asserts observable behaviour instead — what must happen,
 * what must never happen, and which facts must be extracted.
 */

export type EvalCase = {
  /** Stable identifier; referenced in results so a regression can be traced. */
  id: string

  /** Where this requirement comes from. Every case traces to the specification. */
  source: string

  /** What the customer sends, in order. Several entries means several messages. */
  customer: string[]

  /** What a good turn must do. Checked against the run, not against wording. */
  mustDo: string[]

  /**
   * What a turn must never do. These are the eight safety rules made testable.
   * A case failing here is a release blocker, not a quality score.
   */
  mustNotDo: string[]

  /** Fields the turn should have extracted, if any. */
  expectExtracted?: Partial<{
    vehicle: string
    startDate: string
    endDate: string
    duration: string
    deliveryPreference: 'delivery' | 'collection'
    location: string
    budget: string
  }>

  /** The handling the backend should decide on. */
  expectAction?: 'draft' | 'hold' | 'handoff' | 'ask_operations'

  /**
   * True when the right reply depends on this operator's own policy — their
   * deposit, their minimum age, their delivery areas. The case is real; the
   * expected content cannot be written by anyone but the operator.
   */
  needsOperatorAnswer: boolean

  /** What to ask the operator, when needsOperatorAnswer is true. */
  operatorQuestion?: string

  /** Free-text note about why this case exists. */
  note?: string
}

export type EvalSuite = {
  name: string
  cases: EvalCase[]
}

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

import type { PolicyTopic } from '@vyra/contracts'

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
   * Set when the backend settles this case before a model is ever consulted,
   * so the model must not be graded on it.
   *
   * `voice-note` is the example that forced this field. The requirement is
   * real — a voice note is stored, acknowledged and routed to a person — but
   * `decideHandling` holds every non-text message with `non_text_needs_a_person`
   * before the worker builds a turn, so no model in production ever sees one.
   * Grading a model on it marked a blocking failure for a path that does not
   * exist, and the requirement is already covered where it belongs, in
   * app/worker/test/process-inbound-message.test.ts.
   *
   * The case stays in the suite because it still describes required system
   * behaviour, and because a future change that lets models read transcribed
   * audio would need it back.
   */
  decidedBeforeTheModel?: boolean

  /**
   * True when the right reply depends on this operator's own policy — their
   * deposit, their minimum age, their delivery areas. The case is real; the
   * expected content cannot be written by anyone but the operator.
   */
  needsOperatorAnswer: boolean

  /**
   * Set when the customer's message is itself a question about this published
   * topic, so the turn must look the answer up before replying.
   *
   * Distinct from `needsOperatorAnswer`, and the two were conflated at first
   * with a real cost: a model was marked as failing `out-of-hours` and
   * `goes-quiet` for not calling `get_operator_policy`, when neither case
   * involves a customer asking anything. Business hours and follow-up timing
   * are operator configuration the backend acts on — hours shape what the
   * agent says about response time, follow-up timing is a scheduling decision
   * taken later — and section 18.8 puts approved knowledge like that in the
   * model's context rather than behind a tool call.
   *
   * So `needsOperatorAnswer` means the expected content depends on the
   * operator. This means the model must go and fetch it mid-turn.
   */
  policyTopicAsked?: PolicyTopic

  /** What to ask the operator, when needsOperatorAnswer is true. */
  operatorQuestion?: string

  /** Free-text note about why this case exists. */
  note?: string
}

export type EvalSuite = {
  name: string
  cases: EvalCase[]
}

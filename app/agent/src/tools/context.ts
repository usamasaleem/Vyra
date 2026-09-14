import type { QueryRunner, Transactor } from '@vyra/db'

/**
 * Build plan step 24 — the half of every tool call the model cannot reach.
 *
 * Section 18.7: "Background jobs receive internal IDs and reload trusted
 * records; they do not inherit authorization from a model-generated argument."
 * This type is that sentence made structural. The worker builds it by reloading
 * records from the database (see the worker's `loadConversationContext`), and
 * the model contributes nothing to it.
 *
 * The practical consequence is worth stating plainly, because it is the single
 * most important property of the whole boundary: there is no tool argument
 * named `operator_id`. A model cannot ask for another operator's policy,
 * because it has no way to name another operator. Cross-tenant access through
 * the AI path is not blocked by a check that could be forgotten — it is
 * unreachable through the schema.
 *
 * `enquiryId` and `messageId` follow the same rule for a different reason.
 * The evidence attached to an extracted fact must be the message that actually
 * carried it (section 7), so the model does not get to choose which message it
 * cites.
 */
export type ToolContext = {
  operatorId: string
  conversationId: string
  enquiryId: string
  /** The inbound message this turn is answering. The evidence for anything recorded. */
  messageId: string
  /** The operator's IANA timezone, for resolving relative dates. */
  timezone: string
  /** Fixed for the whole turn, so two tools cannot disagree about "today". */
  now: Date
  run: QueryRunner
  transact: Transactor
}

import {
  classifyTurnEnd,
  runTurn,
  type ModelAdapter,
  type ToolContext,
} from '@vyra/agent'
import {
  acceptTurnOutput,
  ensureEnquiry,
  recordOutstandingWork,
  recordRejectedTurn,
  recordTurnFailure,
  type TurnDestination,
} from '@vyra/db'
import type { QueryRunner, Transactor } from '@vyra/db'
import type { ConversationContext } from './context.js'

/**
 * The AI turn — where every piece built for it finally meets.
 *
 * The order below is the whole design, and none of it is the model's to
 * decide:
 *
 *   1. Read the conversation revision BEFORE calling the model (step 25).
 *   2. Run the model behind the tool boundary, which refuses on its own
 *      authority whatever the model asks for (step 24).
 *   3. Decide whether the turn failed, where "produced no reply" is a failure
 *      (step 28).
 *   4. Re-check the revision inside a transaction before the reply is accepted
 *      (step 25 again — the half that matters).
 *
 * Step 1 is the one that is easy to get wrong and impossible to notice: read
 * the revision after the model returns and every comparison succeeds forever.
 */

export type TurnResult =
  | { outcome: 'queued'; messageId: string | null }
  | { outcome: 'drafted'; noteId: string | null }
  | { outcome: 'rejected'; reason: string }
  | { outcome: 'failed'; kind: string; detail: string }
  | { outcome: 'skipped'; reason: 'no_model_configured' | 'no_enquiry' | 'no_message_body' }

export type TurnDependencies = {
  run: QueryRunner
  transact: Transactor
  /** Null when no key is configured. The worker still runs; it just does not think. */
  model: ModelAdapter | null
  destination: TurnDestination
  now?: () => Date
}

export async function runConversationTurn(
  deps: TurnDependencies,
  context: ConversationContext,
): Promise<TurnResult> {
  if (deps.model === null) return { outcome: 'skipped', reason: 'no_model_configured' }
  if (context.message.body === null || context.message.body.trim() === '') {
    return { outcome: 'skipped', reason: 'no_message_body' }
  }

  /**
   * Captured here, before anything slow happens. Everything downstream compares
   * against this number, so where it is read is the mechanism.
   */
  const revisionAtTurnStart = context.conversation.revision

  const enquiryId = await ensureEnquiry(deps.run, context.operator.id, context.conversation.id)
  if (enquiryId === null) return { outcome: 'skipped', reason: 'no_enquiry' }

  const toolContext: ToolContext = {
    operatorId: context.operator.id,
    conversationId: context.conversation.id,
    enquiryId,
    messageId: context.message.id,
    timezone: context.operator.timezone,
    now: deps.now?.() ?? new Date(),
    run: deps.run,
    transact: deps.transact,
  }

  /**
   * A provider failure is not an exception to propagate. Section 18.8 asks for
   * a failure state and a human task, and letting this throw would retry the
   * job — spending money to reproduce an outage — while the customer waits
   * with no reply and nothing visible to a salesperson.
   */
  let end
  try {
    /**
     * The whole recent conversation, oldest first, not just the newest message.
     *
     * `loadConversationContext` already ends this list with the message being
     * answered, so it is not appended again. Outbound messages become 'agent'
     * turns: a reply the customer has already read is part of what was said,
     * whether a model or a salesperson wrote it.
     */
    const transcript = context.recentMessages
      .filter((m) => m.body !== null && m.body.trim() !== '')
      .map((m) => ({
        from: m.direction === 'inbound' ? ('customer' as const) : ('agent' as const),
        text: m.body as string,
      }))

    const outcome = await runTurn(deps.model, toolContext, transcript)
    end = {
      reply: outcome.reply,
      stoppedBecause: outcome.stoppedBecause,
      toolCalls: outcome.toolCalls,
    }
  } catch (error) {
    end = {
      reply: null,
      stoppedBecause: 'error' as const,
      toolCalls: [],
      error: error instanceof Error ? error.message : String(error),
    }
  }

  const failure = classifyTurnEnd(end)
  if (failure !== null) {
    await recordTurnFailure(deps.run, {
      conversationId: context.conversation.id,
      operatorId: context.operator.id,
      kind: failure.kind,
      detail: failure.detail,
      messageId: context.message.id,
    })
    return { outcome: 'failed', kind: failure.kind, detail: failure.detail }
  }

  /**
   * Did this turn hand the conversation over itself?
   *
   * If so, the conversation is human-owned *because of* the reply about to be
   * accepted, and rejecting it as superseded would swallow the one sentence
   * the customer needs — that a colleague is coming.
   */
  const ownHandoff = end.toolCalls.some(
    (call) => call.requestedName === 'request_handoff' && call.status === 'ok',
  )

  const accepted = await acceptTurnOutput(deps.transact, {
    conversationId: context.conversation.id,
    operatorId: context.operator.id,
    revisionAtTurnStart,
    body: end.reply as string,
    // Per inbound message, so a retried job cannot produce a second reply to
    // the same customer message.
    idempotencyKey: `turn:${context.message.id}`,
    destination: deps.destination,
    ownHandoff,
  })

  if (!accepted.accepted) {
    await recordRejectedTurn(deps.transact, {
      conversationId: context.conversation.id,
      operatorId: context.operator.id,
      reason: accepted.reason,
      revisionAtTurnStart,
      revisionNow: accepted.revisionNow,
    })
    return { outcome: 'rejected', reason: accepted.reason }
  }

  /**
   * Anything the tools could not finish becomes visible work.
   *
   * After acceptance, not before: a turn that was superseded should not leave a
   * task behind for a conversation that has moved on. Skipped when the model
   * handed off, because a handoff already puts the whole conversation in front
   * of a person and two competing next actions help nobody.
   */
  if (!ownHandoff) {
    const items = end.toolCalls
      .map((call) => call.needsAPerson)
      .filter((item): item is string => item !== null)

    if (items.length > 0) {
      await recordOutstandingWork(deps.run, {
        conversationId: context.conversation.id,
        operatorId: context.operator.id,
        items,
        messageId: context.message.id,
      })
    }
  }

  return accepted.destination === 'draft'
    ? { outcome: 'drafted', noteId: accepted.noteId }
    : { outcome: 'queued', messageId: accepted.queued.messageId }
}

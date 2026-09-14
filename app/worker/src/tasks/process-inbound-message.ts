import { detectOptOut } from '@vyra/contracts'
import { cancelFollowUps, recordOptOut } from '@vyra/db'
import { loadConversationContext, type ConversationContext } from '../context.js'
import type { QueryRunner } from '../relay.js'

/**
 * Build plan step 10 — the worker skeleton.
 *
 * Loads operator policy, conversation, ownership and recent messages, decides
 * what would happen next, and stops. It sends nothing: the dispatcher is step
 * 11 and the AI turn is phase 4.
 */

export type Handling =
  | { action: 'draft'; reason: 'ready_for_ai_turn' }
  | { action: 'hold'; reason: HoldReason }

export type HoldReason =
  | 'system_kill_switch'
  | 'operator_ai_disabled'
  | 'human_owns_the_conversation'
  | 'contact_opted_out'
  | 'non_text_needs_a_person'
  | 'no_dispatcher_yet'

/**
 * Why a reply would or would not happen, decided in the backend rather than
 * left to a prompt.
 *
 * Order matters: the kill switches come first because they must win over every
 * other consideration. Section 14 requires a system-wide switch that stops AI
 * replies while ingestion and staff access keep working, and a switch that can
 * be reasoned around is not a switch.
 */
export function decideHandling(
  context: ConversationContext,
  options: { systemAiSendingEnabled: boolean; dispatcherAvailable: boolean },
): Handling {
  if (!options.systemAiSendingEnabled) {
    return { action: 'hold', reason: 'system_kill_switch' }
  }
  if (!context.operator.aiSendingEnabled) {
    return { action: 'hold', reason: 'operator_ai_disabled' }
  }
  /**
   * Before human ownership, though both hold and the choice changes nothing
   * about what happens.
   *
   * What it changes is what a salesperson reads in the inbox. Recording an
   * opt-out also hands the conversation to a person, so with the old ordering
   * every opted-out conversation reported "human owns the conversation" — true,
   * and a description of the consequence rather than the cause. One of these
   * reasons tells you the customer asked to be left alone; the other does not.
   *
   * The two switches above stay first because they are facts about the whole
   * operator rather than this contact.
   */
  if (context.contact.optedOutAt !== null) {
    return { action: 'hold', reason: 'contact_opted_out' }
  }
  // Section 10 of the MVP: the AI does not send while human ownership is
  // active. One handler at a time, always.
  if (context.conversation.handlerMode === 'human') {
    return { action: 'hold', reason: 'human_owns_the_conversation' }
  }
  // A voice note or photo is stored and acknowledged, never silently dropped,
  // and never treated as though the customer said nothing. Until the AI can
  // interpret one, it routes to a person.
  if (context.message.kind !== 'text') {
    return { action: 'hold', reason: 'non_text_needs_a_person' }
  }
  if (!options.dispatcherAvailable) {
    return { action: 'hold', reason: 'no_dispatcher_yet' }
  }
  return { action: 'draft', reason: 'ready_for_ai_turn' }
}

export type ProcessResult =
  | { outcome: 'message_not_found' }
  | { outcome: 'operator_mismatch' }
  | {
      outcome: 'processed'
      handling: Handling
      context: ConversationContext
      /** Set when this message was an opt-out and this call recorded it. */
      optedOut?: { matched: string; cancelledMessages: number }
    }

export async function processInboundMessage(
  run: QueryRunner,
  payload: { message_id?: unknown; operator_id?: unknown },
  options: { systemAiSendingEnabled: boolean; dispatcherAvailable: boolean },
): Promise<ProcessResult> {
  const messageId = typeof payload.message_id === 'string' ? payload.message_id : null
  if (messageId === null) return { outcome: 'message_not_found' }

  const context = await loadConversationContext(run, messageId)
  // A job whose message no longer exists is done, not failed. Retrying it
  // forever would fill the dead queue with noise.
  if (context === null) return { outcome: 'message_not_found' }

  /**
   * The payload's operator id is a claim, not authority. Scoping came from the
   * message row itself; this only catches a job that was built wrongly, which
   * would otherwise be invisible.
   */
  if (
    typeof payload.operator_id === 'string' &&
    payload.operator_id !== context.operator.id
  ) {
    return { outcome: 'operator_mismatch' }
  }

  /**
   * The customer replied, so stop chasing them.
   *
   * Section 11: reopen a lead when the customer replies. A scheduled chase that
   * survives a reply is the message that arrives an hour after the customer
   * already answered, asking whether they are still interested.
   */
  await cancelFollowUps(run, {
    operatorId: context.operator.id,
    conversationId: context.conversation.id,
    reason: 'customer_replied',
  })

  /**
   * Opt-out is checked here, before anything else looks at the message, and
   * acted on rather than noted.
   *
   * A rule, not a tool: the eval run showed a model replying "Understood. I
   * won't message you again" and calling nothing, because nothing existed for
   * it to call. Honouring an opt-out must not depend on a model choosing to.
   *
   * It runs before `decideHandling` so the flag it sets is visible to the very
   * decision that reads it — `contact_opted_out` is already a hold reason, and
   * the mutated context below makes this turn take it too rather than waiting
   * for the next message.
   */
  const optOut = context.message.kind === 'text' && context.message.body !== null
    ? detectOptOut(context.message.body)
    : null

  if (optOut !== null) {
    const result = await recordOptOut(run, {
      contactId: context.contact.id,
      operatorId: context.operator.id,
      conversationId: context.conversation.id,
      matched: optOut.matched,
      messageId: context.message.id,
    })

    // The context was loaded before the write, so it still says null.
    const optedContext: ConversationContext = {
      ...context,
      contact: { ...context.contact, optedOutAt: new Date() },
      conversation: { ...context.conversation, handlerMode: 'human' },
    }

    return {
      outcome: 'processed',
      handling: decideHandling(optedContext, options),
      context: optedContext,
      ...(result.recorded
        ? { optedOut: { matched: optOut.matched, cancelledMessages: result.cancelledMessages } }
        : {}),
    }
  }

  return { outcome: 'processed', handling: decideHandling(context, options), context }
}

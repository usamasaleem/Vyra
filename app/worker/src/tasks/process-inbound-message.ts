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
  // Section 10 of the MVP: the AI does not send while human ownership is
  // active. One handler at a time, always.
  if (context.conversation.handlerMode === 'human') {
    return { action: 'hold', reason: 'human_owns_the_conversation' }
  }
  if (context.contact.optedOutAt !== null) {
    return { action: 'hold', reason: 'contact_opted_out' }
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
  | { outcome: 'processed'; handling: Handling; context: ConversationContext }

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

  return { outcome: 'processed', handling: decideHandling(context, options), context }
}

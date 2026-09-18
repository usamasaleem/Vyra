import { detectOptOut, detectStopSignal, type StopCode } from '@vyra/contracts'
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
  | { action: 'hold'; reason: HoldReason; urgent?: { code: StopCode; matched: string; why: string } }

export type HoldReason =
  | 'system_kill_switch'
  | 'operator_ai_disabled'
  | 'human_owns_the_conversation'
  | 'contact_opted_out'
  | 'non_text_needs_a_person'
  | 'reaction_needs_no_reply'
  | 'urgent_needs_a_person'
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
  /**
   * Accidents, injuries, fraud disputes and legal complaints, decided by rule
   * before any model call.
   *
   * Section 15 requires immediate escalation for these, and says it is a
   * backend rule rather than a prompt instruction — because a model asked "is
   * this an accident report?" will usually be right, and usually is the wrong
   * standard for somebody who has just crashed a Lamborghini.
   *
   * The rule has existed since step 23 and ran nowhere: intents.ts was
   * imported by its own test and nothing else. Written, reviewed, reachable
   * from no code path, which is the same as not having it.
   *
   * Only `urgent_support` acts here. The other two stop rules are handled
   * better elsewhere and moving them would make the agent worse — see the
   * header of intents.ts for why.
   *
   * After the opt-out check, which outranks everything: somebody who asked to
   * be left alone is not made an exception of by shouting.
   */
  if (context.message.kind === 'text' && context.message.body !== null) {
    const stop = detectStopSignal(context.message.body)
    if (stop !== null && stop.intent === 'urgent_support' && stop.code !== undefined) {
      return {
        action: 'hold',
        reason: 'urgent_needs_a_person',
        urgent: { code: stop.code, matched: stop.matched ?? '', why: stop.reason ?? '' },
      }
    }
  }

  /**
   * A reaction is a real action and not a question. Stored, shown in the
   * transcript, and answered with nothing.
   *
   * Before this it fell into `unsupported` and took the voice-note path: an
   * apology for not being able to read it, and a handoff. The handoff is the
   * part that hurt — it moved the conversation into human hands, so the real
   * question fifty minutes later went unanswered for six minutes. A thumbs-up
   * cost a handoff and a silence.
   *
   * Ahead of the non-text check, which would otherwise catch it first.
   */
  if (context.message.kind === 'reaction') {
    return { action: 'hold', reason: 'reaction_needs_no_reply' }
  }
  /**
   * A voice note that has been transcribed is a message like any other.
   *
   * `kind` stays `audio` — it was spoken, the inbox should say so, and the
   * model is told so. What changes is that there are now words to answer, and
   * holding a message we can read would be the same silence section 17 forbids
   * for one we cannot.
   *
   * Everything else non-text still routes to a person: a photograph, a
   * document, a location. And a voice note whose transcription failed has a
   * null body and falls through to exactly the path it always took.
   */
  if (context.message.kind !== 'text' && context.message.body === null) {
    return { action: 'hold', reason: 'non_text_needs_a_person' }
  }
  if (context.message.kind !== 'text' && context.message.kind !== 'audio') {
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
   *
   * Not for a reaction. A thumbs-up is not an answer, and cancelling here would
   * be the end of the chase rather than a pause in it: the turn is what
   * schedules the next one, and a reaction is held before the turn runs. The
   * customer would react once and never hear from us again.
   */
  if (context.message.kind !== 'reaction') {
    await cancelFollowUps(run, {
      operatorId: context.operator.id,
      conversationId: context.conversation.id,
      reason: 'customer_replied',
    })
  }

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

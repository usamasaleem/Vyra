import {
  classifyTurnEnd,
  runTurn,
  type ModelAdapter,
  type ToolContext,
} from '@vyra/agent'
import {
  acceptTurnOutput,
  ensureEnquiry,
  requestHandoff,
  recordOutstandingWork,
  recordRejectedTurn,
  recordTurnFailure,
  raiseHandoff,
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
  | { outcome: 'needs_a_person'; reason: 'non_text_message' }
  | { outcome: 'skipped'; reason: 'no_model_configured' | 'no_enquiry' | 'no_message_body' }

/**
 * What a salesperson reads in the queue.
 *
 * The message kind is a database enum, and interpolating it into a sentence
 * produced "Customer sent a audio the agent cannot read" — which a person
 * reads, in a list of things asking for their attention, and which looks
 * broken. "a image" and "a video" were queued up behind it.
 */
const NON_TEXT_DESCRIPTION: Record<string, string> = {
  audio: 'a voice note',
  image: 'a photo',
  video: 'a video',
  document: 'a document',
  sticker: 'a sticker',
  location: 'a location',
  contacts: 'a contact card',
}

/** What a customer hears when they send something the agent cannot read. */
const NON_TEXT_ACKNOWLEDGEMENT: Record<string, string> = {
  audio: "Thanks — I can't listen to voice notes, so I'm passing this to a colleague who will.",
  image: "Thanks for the photo — I can't view images, so a colleague will take a look and come back to you.",
  video: "Thanks — I can't watch videos, so a colleague will take a look and come back to you.",
  document: "Thanks for the file — I can't open documents, so a colleague will review it and come back to you.",
}

const DEFAULT_ACKNOWLEDGEMENT =
  "Thanks — I can't read that kind of message, so a colleague will take a look and come back to you."

/**
 * Build plan step 27 — a voice note is stored, acknowledged and routed.
 *
 * `decideHandling` has always held non-text messages with the reason
 * `non_text_needs_a_person`, and the comment beside it said they were
 * "stored and acknowledged, never silently dropped". Two of those three were
 * true. Nothing acknowledged anything and nothing routed anywhere: next_action
 * stayed null, the handler stayed AI, and the customer's voice note was
 * answered with silence by a system that had correctly decided a person was
 * needed.
 *
 * Section 17 is explicit that it must never be treated as though the customer
 * said nothing. So this sends one honest sentence — no guess at the contents —
 * and puts the conversation in front of someone.
 */
export async function handleNonTextMessage(
  deps: Pick<TurnDependencies, 'run' | 'transact' | 'destination'>,
  context: ConversationContext,
): Promise<TurnResult> {
  const body = NON_TEXT_ACKNOWLEDGEMENT[context.message.kind] ?? DEFAULT_ACKNOWLEDGEMENT

  const description = NON_TEXT_DESCRIPTION[context.message.kind]
    ?? `a ${context.message.kind} message`
  const summary = `Customer sent ${description} the agent cannot read — review it and reply.`

  await requestHandoff(deps.run, {
    conversationId: context.conversation.id,
    operatorId: context.operator.id,
    reason: summary,
  })

  // The task, not just the pause. Section 18.11: a handoff summary without an
  // assigned task is not a completed handoff.
  await raiseHandoff(deps.run, {
    operatorId: context.operator.id,
    conversationId: context.conversation.id,
    reason: 'non_text_message',
    summary,
    triggerMessageId: context.message.id,
  })

  /**
   * Queued after the handoff, and allowed through by the same rule that lets a
   * handoff acknowledgement past: the conversation is human-owned but unowned,
   * so this one message at the post-handoff revision still sends.
   */
  await acceptTurnOutput(deps.transact, {
    conversationId: context.conversation.id,
    operatorId: context.operator.id,
    revisionAtTurnStart: context.conversation.revision,
    body,
    idempotencyKey: `non-text:${context.message.id}`,
    destination: deps.destination,
    ownHandoff: true,
  })

  return { outcome: 'needs_a_person', reason: 'non_text_message' }
}

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
    await raiseHandoff(deps.run, {
      operatorId: context.operator.id,
      conversationId: context.conversation.id,
      reason: 'turn_failed',
      summary: `The agent could not reply (${failure.kind}) — answer this customer manually.`,
      triggerMessageId: context.message.id,
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

  /**
   * The model decided a person is needed, so a person gets a task with a clock
   * on it. Raised before acceptance, because the handoff already happened
   * inside the tool call — if the reply is then rejected as superseded, the
   * work is still real and someone should still see it.
   */
  if (ownHandoff) {
    // Read fresh: request_handoff wrote the reason into next_action a moment
    // ago, after this turn's context was loaded. The model's own sentence about
    // why it handed over is better than anything generic written here.
    const [current] = await deps.run(
      `select next_action from conversations where id = $1 and operator_id = $2`,
      [context.conversation.id, context.operator.id],
    )
    await raiseHandoff(deps.run, {
      operatorId: context.operator.id,
      conversationId: context.conversation.id,
      reason: 'customer_asked',
      summary: (current?.['next_action'] as string)
        ?? 'The agent handed this conversation to a person.',
      triggerMessageId: context.message.id,
    })
  }

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

import {
  asksToSeePhotos, buttonsFor, detectDiscountRequest, invitesACarChoice, vehicleList,
} from '@vyra/contracts'

/** The shape search_vehicles returns, as much of it as a list row needs. */
type VehicleRow = {
  make: string
  model: string
  variant: string | null
  colour: string
  engine: string | null
  dayRate: string | null
}
import {
  classifyTurnEnd,
  promiseMadeIn,
  PROMPT_VERSION,
  runTurn,
  summariseConversation,
  type ModelAdapter,
  type ToolContext,
  type TurnEnd,
  type TurnUsage,
} from '@vyra/agent'
import {
  acceptTurnOutput,
  ensureEnquiry,
  recordAgentRun,
  findVehiclePhotos,
  loadMessagesBeforeWindow,
  photosSentIn,
  saveConversationSummary,
  requestHandoff,
  recordOutstandingWork,
  recordRejectedTurn,
  scheduleFollowUp,
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
  const startedAt = Date.now()

  /**
   * Declared up front because the recorder below closes over it. Inference
   * cannot reach a variable assigned later in a try/catch, and naming the shape
   * is better than widening it to any.
   */
  let end: (TurnEnd & {
    rounds: number
    usage?: TurnUsage
    /** What the tools returned, so the reply can offer what they found. */
    toolResults: Array<{ name: string; result: { status: string } }>
  }) | undefined

  /**
   * One row per turn, written on every path out of this function.
   *
   * Placed here rather than at each return so no exit can quietly skip it: a
   * run log with holes in it is worse than none, because the holes are exactly
   * the turns worth looking at. The error is logged and swallowed — a turn that
   * replied correctly must not become a failure because the record of it could
   * not be written.
   */
  const record = async (resultState: string, detail?: string | null) => {
    const outcome = await recordAgentRun(deps.run, {
      operatorId: context.operator.id,
      conversationId: context.conversation.id,
      messageId: context.message.id,
      inputRevision: revisionAtTurnStart,
      promptVersion: PROMPT_VERSION,
      modelId: deps.model?.modelId ?? 'none',
      resultState,
      detail: detail ?? null,
      rounds: end?.rounds ?? 0,
      toolNames: (end?.toolCalls ?? []).map((c) => `${c.requestedName}:${c.status}`),
      durationMs: Date.now() - startedAt,
      usage: end?.usage,
    })
    if (!outcome.recorded) {
      console.error(JSON.stringify({
        event: 'agent_run.record_failed',
        conversationId: context.conversation.id,
        error: outcome.error,
      }))
    }
  }

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

    const outcome = await runTurn(deps.model, toolContext, transcript, {
      // What fell out of the window. Null until a conversation is long enough
      // to have lost anything.
      summary: context.conversation.summary,
    })
    end = {
      reply: outcome.reply,
      stoppedBecause: outcome.stoppedBecause,
      toolCalls: outcome.toolCalls,
      rounds: outcome.rounds,
      usage: outcome.usage,
      toolResults: outcome.toolResults,
    }
  } catch (error) {
    end = {
      reply: null,
      stoppedBecause: 'error' as const,
      toolCalls: [],
      rounds: 0,
      toolResults: [],
      // A provider that threw reported no usage, and the tokens it may still
      // have charged for are not knowable from here. Undefined says so.
      usage: undefined,
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
    await record(failure.kind, failure.detail)
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

  /**
   * What the customer can tap, if anything.
   *
   * A list of cars only when the reply actually invites a choice: three
   * vehicles coming back from a search does not mean the agent asked the
   * customer to pick one, and a menu attached to an answer is the flow-builder
   * product this is deliberately not.
   *
   * The vehicles come from what the tools returned this turn, not from the
   * reply text, so the rows are the cars the agent was actually looking at.
   */
  const searched = end.toolResults
    .filter((r) => r.name === 'search_vehicles' && r.result.status === 'ok')
    .at(-1)
  const fleet = searched === undefined
    ? []
    : ((searched.result as { data?: { fleet?: VehicleRow[] } }).data?.fleet ?? [])

  const offered = {
    buttons: buttonsFor(end.reply),
    list: invitesACarChoice(end.reply) ? vehicleList(fleet) : null,
  }

  /**
   * A photograph of the car, when the turn is about exactly one of them.
   *
   * Exactly one, because a reply about three cars has no single picture, and
   * showing one of them silently favours it. Never alongside buttons or a list,
   * which cannot be attached to an image — a tap moves the conversation
   * forward and a photograph only makes it nicer to look at.
   *
   * Looked up from the database rather than taken from the tool result, so a
   * URL is never in front of the model and can never be pasted into a reply.
   */
  const photos = fleet.length === 1 && offered.list === null && offered.buttons === null
    ? await findVehiclePhotos(deps.run, {
        operatorId: context.operator.id,
        make: fleet[0]!.make,
        model: fleet[0]!.model,
      }).catch((error: unknown) => {
        /**
         * A picture is a nicety; the reply is the product.
         *
         * Malformed data in this column stopped a customer being answered at
         * all — the turn threw, the job retried, and the retry threw again.
         * Nothing about decorating a message should be able to do that.
         */
        console.error(JSON.stringify({
          event: 'photo.lookup_failed',
          conversationId: context.conversation.id,
          error: error instanceof Error ? error.message : String(error),
        }))
        return []
      })
    : []

  /**
   * How many pictures a salesperson sends when they introduce a car.
   *
   * Three. Enough to show the outside and the cabin, few enough that a phone
   * is not filled with one car. WhatsApp has no album, so each is its own
   * message and the client stacks them — which also means a fourth is a fourth
   * notification.
   */
  const PHOTOS_PER_CAR = 3

  const seen = photos.length === 0
    ? new Set<string>()
    : await photosSentIn(deps.run, {
        conversationId: context.conversation.id,
        operatorId: context.operator.id,
      })

  /**
   * Once by default, and again the moment they ask.
   *
   * Live, a customer said "Can you send me more images related to this car" and
   * then "show me side profile", and got prose both times: the pictures had
   * been sent once already and the rule suppressed them. A rule meant to stop
   * repetition was refusing a direct request.
   *
   * Asked, they get what they have not seen — so a second request shows
   * something new rather than the same shot. When they have seen everything,
   * they get it again, because they asked and having nothing new is not a
   * reason to answer a question about pictures with a paragraph.
   */
  const asked = asksToSeePhotos(context.message.body)
  const unseen = photos.filter((url) => !seen.has(url))

  const showing = asked
    ? (unseen.length > 0 ? unseen : photos).slice(0, PHOTOS_PER_CAR)
    : (seen.size === 0 ? photos.slice(0, PHOTOS_PER_CAR) : [])

  const accepted = await acceptTurnOutput(deps.transact, {
    conversationId: context.conversation.id,
    operatorId: context.operator.id,
    revisionAtTurnStart,
    body: end.reply as string,
    /**
     * Two closed questions get a tap instead of a typed answer. Everything
     * else — which is nearly everything — goes as plain text, because a menu
     * on an open question is the fixed-flow bot this is not.
     */
    replyButtons: offered.list === null ? offered.buttons : null,
    replyList: offered.list,
    replyImageUrl: showing[0] ?? null,
    // The rest follow as their own messages, with no caption.
    extraImageUrls: showing.slice(1),
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
    await record('rejected', accepted.reason)
    return { outcome: 'rejected', reason: accepted.reason }
  }

  /**
   * A discount asked for is a handoff, whatever the model decided.
   *
   * MVP section 8 lists it as a trigger and section 12 forbids the agent
   * approving one — two halves of the same rule, and the model satisfied
   * neither. Asked "can you do 3000 for the weekend instead?" it replied
   * "I'll check what we can do for AED 3,000" and called nothing, which is a
   * negotiation opened on the operator's behalf with nobody informed.
   *
   * Detected from the customer's message rather than the reply, because what
   * makes this a handoff is what they asked for. The agent still answers:
   * acknowledging and capturing the context is the useful half, and section
   * 17.5 asks for it. What is guaranteed is that a person gets the decision.
   *
   * Raised before the promise check so a discount ask that also promised a
   * person produces one handoff rather than two.
   *
   * Outside the `ownHandoff` guard, and that placement is the whole fix. It was
   * inside, and live the model raised its own handoff first — so `ownHandoff`
   * was true, this never ran, and the ask was recorded as a generic
   * `customer_asked` instead of a discount at high priority. A rule that only
   * applies when the model did nothing is not a rule, it is a fallback.
   */
  const discount = detectDiscountRequest(context.message.body)
  if (discount !== null) {
    await raiseHandoff(deps.run, {
      operatorId: context.operator.id,
      conversationId: context.conversation.id,
      reason: 'discount_requested',
      summary: `${discount.reason} — "${discount.matched}". Only a manager can approve one.`,
      triggerMessageId: context.message.id,
    })
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

    /**
     * A promise the turn made and did not keep.
     *
     * The reply told the customer something would happen. If no tool started
     * it, nothing will — that is exactly what went out live: "I'll get a
     * salesperson to confirm the highest-priced car", no request_handoff, no
     * task, nobody told. The customer waits on a sentence.
     *
     * Read from the reply rather than the tools on purpose. Every other signal
     * here describes what the system did; this one is the only thing that
     * describes what the customer was told, and the gap between the two is the
     * bug. A promise of a person becomes a handoff with a clock on it; a
     * promise to go and check becomes visible work. Both are things a person
     * can dismiss in a second if the heuristic was wrong.
     *
     * Ownership deliberately does not change. The handoff puts a person in the
     * queue; it does not stop the agent replying, because a false positive that
     * silences a working conversation reproduces the failure this is meant to
     * fix. A salesperson who picks it up takes over explicitly, as they would
     * with any other handoff.
     */
    const promised = discount === null && items.length === 0
      ? promiseMadeIn(end.reply)
      : null

    if (promised === 'person') {
      await raiseHandoff(deps.run, {
        operatorId: context.operator.id,
        conversationId: context.conversation.id,
        reason: 'customer_asked',
        summary:
          'The agent told this customer a person would come back to them, and did not hand the '
          + `conversation over. Its exact words: "${(end.reply ?? '').slice(0, 300)}"`,
        triggerMessageId: context.message.id,
      })
    } else if (promised === 'check') {
      items.push(
        'The agent promised to check something and no tool recorded it. Its exact words: '
        + `"${(end.reply ?? '').slice(0, 300)}"`,
      )
    }

    if (items.length > 0) {
      await recordOutstandingWork(deps.run, {
        conversationId: context.conversation.id,
        operatorId: context.operator.id,
        items,
        messageId: context.message.id,
      })
    }
  }

  /**
   * The agent has replied, so the ball is with the customer. Schedule a chase
   * in case it stays there.
   *
   * Not scheduled when the turn handed off — a person owns that conversation
   * and does not need the agent chasing beside them. Every other stop condition
   * is inside `scheduleFollowUp`'s own predicate rather than checked here, so
   * no future caller can skip them.
   */
  if (!ownHandoff) {
    const [operator] = await deps.run(
      `select follow_up_after_minutes from operators where id = $1`,
      [context.operator.id],
    )
    await scheduleFollowUp(deps.run, {
      operatorId: context.operator.id,
      conversationId: context.conversation.id,
      reason: 'awaiting_customer',
      afterMinutes: Number(operator?.['follow_up_after_minutes'] ?? 240),
    })
  }

  /**
   * Keep the notes current, after the customer already has their answer.
   *
   * Deliberately last, and deliberately not awaited for the customer's benefit:
   * this is a second model call, and the reply must not wait behind it. It is
   * still awaited by the job so a failure is visible and the worker does not
   * exit mid-call.
   *
   * Regenerated only when enough new messages have fallen out of the window,
   * not every turn. A summary rewritten on every message is a second model call
   * per reply for a paragraph that barely changes.
   */
  await refreshSummaryIfStale(deps, context)

  // 'drafted' and 'queued' are different outcomes worth telling apart: a draft
  // was paid for and never reached the customer.
  await record(accepted.destination === 'draft' ? 'drafted' : 'queued')

  return accepted.destination === 'draft'
    ? { outcome: 'drafted', noteId: accepted.noteId }
    : { outcome: 'queued', messageId: accepted.queued.messageId }
}


/**
 * How many messages beyond the window may accumulate before the notes are
 * rewritten.
 *
 * Ten is a compromise between spending and staleness: at worst the agent is
 * missing the ten oldest messages that just fell out, which are the least
 * likely to matter, and a long conversation pays for one extra call per ten
 * messages rather than one per reply.
 */
const RESUMMARISE_EVERY = 10

/** Must match the window `loadConversationContext` actually uses. */
const RECENT_WINDOW = 20

async function refreshSummaryIfStale(
  deps: TurnDependencies,
  context: ConversationContext,
): Promise<void> {
  if (deps.model === null) return

  const { messages, totalMessages } = await loadMessagesBeforeWindow(deps.run, {
    conversationId: context.conversation.id,
    operatorId: context.operator.id,
    windowSize: RECENT_WINDOW,
  })

  if (messages.length === 0) return

  const covered = context.conversation.summaryThroughCount
  const fallenOut = totalMessages - RECENT_WINDOW
  if (fallenOut - covered < RESUMMARISE_EVERY && context.conversation.summary !== null) return

  try {
    const summary = await summariseConversation(deps.model, {
      messages,
      previous: context.conversation.summary,
    })
    if (summary === null) return

    await saveConversationSummary(deps.run, {
      conversationId: context.conversation.id,
      operatorId: context.operator.id,
      summary,
      throughCount: fallenOut,
    })
  } catch (error) {
    /**
     * A failed summary must not fail a turn that already replied. The customer
     * has their message; the worst case is that the notes stay one cycle old,
     * and the next turn tries again.
     */
    console.error(JSON.stringify({
      event: 'summary.failed',
      conversationId: context.conversation.id,
      error: error instanceof Error ? error.message : String(error),
    }))
  }
}

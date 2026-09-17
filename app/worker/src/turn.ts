import {
  asksToSeePhotos, asWhatsAppText, buttonsFor, photosPromisedIn, detectDiscountRequest,
  carChosenIn, FULL_RANGE_LABEL, invitesACarChoice, mightNeedTheFleet, offersTheFullRange,
  usableWebsite,
  vehicleList,
} from '@vyra/contracts'

/** The shape search_vehicles returns, as much of it as a list row needs. */
type VehicleRow = {
  make: string
  model: string
  variant: string | null
  colour: string
  engine: string | null
  dayRate: string | null
  /** The operator's own few words, shown first in the list row. */
  highlight?: string | null
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
import { searchVehicles } from '@vyra/agent'
import {
  acceptTurnOutput,
  ensureEnquiry,
  recordAgentRun,
  recordFields,
  carsWithoutPhotos,
  ENQUIRY_FIELDS,
  getEnquiryFields,
  outstandingQuestions,
  recordAsked,
  type EnquiryField,
  advanceStage,
  stageFromEvidence,
  findVehicleImages,
  loadMessagesBeforeWindow,
  photosSentIn,
  photosShownIn,
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
  /**
   * How long the job that triggered this turn waited after becoming due.
   *
   * Passed in rather than measured here because only the caller holds the job,
   * and the wait is over by the time this function is entered.
   */
  queueWaitMs?: number | null
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
  /**
   * Declared out here because it is read twice: once before the model, as a
   * fact for the instructions, and once after, to decide what to quote.
   */
  let photosShown: Awaited<ReturnType<typeof photosShownIn>> = []

  /**
   * The fleet looked up before the model ran, kept for the reply's surfaces.
   * A turn that answered from this called no tool, and everything downstream
   * used to read the tools alone.
   */
  let prefetchedFleet: VehicleRow[] = []

  /** The qualifying question this turn was told to put, if any. */
  let askedThisTurn: EnquiryField[] = []

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
      queueWaitMs: deps.queueWaitMs ?? null,
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

    /**
     * What this customer has already been shown, before the model is asked
     * anything — the once-only rule is applied after the reply is written, so
     * without this the model cannot know a photograph it is about to describe
     * has already been sent, or is about to be suppressed.
     *
     * A nicety, like the pictures themselves, so a failure here costs a
     * sentence of context and never the reply.
     */
    photosShown = await photosShownIn(deps.run, {
      conversationId: context.conversation.id,
      operatorId: context.operator.id,
    }).catch((error: unknown) => {
      console.error(JSON.stringify({
        event: 'photos_shown.lookup_failed',
        conversationId: context.conversation.id,
        error: error instanceof Error ? error.message : String(error),
      }))
      return []
    })

    /**
     * The fleet, looked up before the model is asked anything.
     *
     * A turn takes 4.5 seconds with no tool call and 7.6 with one, and nearly
     * every one of those tool calls is search_vehicles with no filters — a
     * question that could have been answered while the model was still being
     * asked. On a message plainly about cars it is answered in advance, which
     * turns the common two-round turn into one.
     *
     * Run through the tool, not around it. Same code, same refusals, same
     * guidance — so this is a timing change and not a new way into the data.
     *
     * A failure costs a slower turn and nothing else, which is why it is
     * caught here rather than allowed to take the reply down with it.
     */
    const prefetched = mightNeedTheFleet(context.message.body)
      ? await searchVehicles(toolContext, {
          vehicle: null, category: null, maxDayRateMinor: null, minSeats: null,
          order: null, startDate: null, endDate: null,
        })
          .then((result) => result.status === 'ok' ? result.data : undefined)
          .catch((error: unknown) => {
            console.error(JSON.stringify({
              event: 'fleet_prefetch.failed',
              conversationId: context.conversation.id,
              error: error instanceof Error ? error.message : String(error),
            }))
            return undefined
          })
      : undefined

    /**
     * Kept for the surfaces as well as for the prompt.
     *
     * The first version handed the fleet to the model and threw the rows away,
     * and the cost showed up immediately in a real conversation: answering
     * from the prefetch means not calling search_vehicles, and the tappable
     * list was built only from what the tools returned. So a question about
     * three cars came back as a paragraph naming all three, no list, and one
     * photograph of the only car that has any — which reads as singling out
     * the Lamborghini rather than showing a range.
     */
    prefetchedFleet = (prefetched?.fleet ?? []) as VehicleRow[]
    const fleetOnHand = prefetched === undefined ? undefined : JSON.stringify(prefetched)

    /**
     * What the enquiry still needs, and whether it may be asked about again.
     *
     * The agent asked for dates once, the customer asked four questions of
     * their own, and it answered all four and never came back — because
     * nothing told it there was anything outstanding. missingFields has
     * existed since step 21 and was read only by the handoff packet, which
     * informs a person after the conversation has already been handed over.
     *
     * A nicety like the rest of the facts here: a failure costs a question
     * that does not get asked, never the reply.
     */
    /**
     * What this enquiry already knows.
     *
     * The mirror of stillNeeded, and the half that was missing. getEnquiryFields
     * has existed since step 21; the turn read it after the model had already
     * replied, to decide what to record — never before, to decide what to say.
     * So a customer who had given dates the night before was told "I don't have
     * the dates showing on my side", and told us so in the next message.
     *
     * A nicety like the rest of the facts here: if it fails the reply still
     * goes, one memory poorer.
     */
    const known = await getEnquiryFields(deps.run, context.operator.id, enquiryId)
      /**
       * In the order a person would say them, not alphabetically.
       *
       * getEnquiryFields orders by field name, which puts delivery before the
       * car and reads like a form being read out. ENQUIRY_FIELDS is already in
       * the order an enquiry is built up.
       */
      .then((fields) => [...fields]
        .sort((a, b) => ENQUIRY_FIELDS.indexOf(a.field) - ENQUIRY_FIELDS.indexOf(b.field))
        .map((f) => ({
          field: f.field as string,
          value: f.value,
          since: f.extractedAt,
        })))
      .catch((error: unknown) => {
        console.error(JSON.stringify({
          event: 'enquiry_fields.recall_failed',
          conversationId: context.conversation.id,
          error: error instanceof Error ? error.message : String(error),
        }))
        return []
      })

    /**
     * Which cars cannot be shown at all.
     *
     * Fetched whenever the turn might be about cars — the same gate as the
     * fleet prefetch, plus an outright request to see one, because "can you
     * show me" names no car and would otherwise miss.
     *
     * A nicety like the rest: without it the reply still goes, and the model is
     * back to bridging "photographs have been sent" and "show me the Ferrari"
     * with a sentence about photographs of a different car.
     */
    const noPhotosOf = mightNeedTheFleet(context.message.body)
      || asksToSeePhotos(context.message.body)
      ? await carsWithoutPhotos(deps.run, context.operator.id).catch((error: unknown) => {
          console.error(JSON.stringify({
            event: 'photo_coverage.failed',
            conversationId: context.conversation.id,
            error: error instanceof Error ? error.message : String(error),
          }))
          return []
        })
      : []

    const stillNeeded = await outstandingQuestions(deps.run, {
      operatorId: context.operator.id,
      conversationId: context.conversation.id,
      enquiryId,
    }).catch((error: unknown) => {
      console.error(JSON.stringify({
        event: 'outstanding_questions.failed',
        conversationId: context.conversation.id,
        error: error instanceof Error ? error.message : String(error),
      }))
      return []
    })

    /**
     * Counted when it is told to ask, not when it is seen asking.
     *
     * One question of the several outstanding, because the instruction asks
     * for one and counting the rest would silence them before they were ever
     * put. Recorded before the model runs so a turn that fails partway does
     * not ask the same thing again on the retry.
     */
    askedThisTurn = stillNeeded.slice(0, 1).map((q) => q.field)
    if (askedThisTurn.length > 0) {
      await recordAsked(deps.run, {
        operatorId: context.operator.id,
        conversationId: context.conversation.id,
        fields: askedThisTurn,
      }).catch(() => undefined)
    }

    const outcome = await runTurn(deps.model, toolContext, transcript, {
      // What fell out of the window. Null until a conversation is long enough
      // to have lost anything.
      summary: context.conversation.summary,
      photosShown,
      ...(fleetOnHand === undefined ? {} : { fleetOnHand }),
      ...(stillNeeded.length === 0 ? {} : { stillNeeded: stillNeeded.slice(0, 1) }),
      ...(known.length === 0 ? {} : { known }),
      ...(noPhotosOf.length === 0 ? {} : { noPhotosOf }),
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
  /**
   * What the tools returned this turn, or what was looked up before it.
   *
   * The tool result wins: it may be narrower — a category, a budget, a seat
   * count — and the customer asked for the narrower thing. The prefetch is the
   * whole fleet and is only right when nothing else was asked.
   */
  const fleet = searched === undefined
    ? prefetchedFleet
    : ((searched.result as { data?: { fleet?: VehicleRow[] } }).data?.fleet ?? [])

  const offered = {
    buttons: buttonsFor(end.reply),
    list: invitesACarChoice(end.reply) ? vehicleList(fleet) : null,
  }

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

  /**
   * Which car the photographs would be of, when the turn is about exactly one.
   *
   * Exactly one, because a reply about three cars has no single picture, and
   * showing one of them silently favours it. Never alongside buttons or a list,
   * which cannot be attached to an image — a tap moves the conversation
   * forward and a photograph only makes it nicer to look at.
   *
   * Looked up from the database rather than taken from the tool result, so a
   * URL is never in front of the model and can never be pasted into a reply.
   *
   * Normally it is the car the tools just returned. The fallback exists because
   * telling the model what this customer has already seen made it stop looking
   * the car up: given "4 of the Huracán on 15 September" in its instructions it
   * answers from that, in one round with no tool call — faster, and it left the
   * picture path with nothing to work from, because knowing the car came only
   * from a search this turn.
   *
   * So when they asked to see a car and exactly one has ever been shown in this
   * conversation, that is the car. Exactly one for the same reason as above:
   * two cars shown and "send me another angle" names neither, and picking the
   * most recent would be a guess presented as an answer.
   *
   * Only when they asked. Without that this would start attaching photographs
   * to replies about a car mentioned days ago.
   */
  /**
   * Which car the reply is about, when the fleet came from the prefetch.
   *
   * The prefetch is unfiltered, so `fleet` is every car whenever no tool ran —
   * and asking "is this exactly one car" of it is always no. Live, a customer
   * typed "lambo", the agent replied "The green Lamborghini Huracán Tecnica —
   * I sent you a few photos earlier", and nothing was attached, because three
   * cars came back and none of them was "the" car.
   *
   * The reply knows. It named the car; this finds which one it named, and only
   * accepts an unambiguous answer.
   */
  const namedInReply = searched !== undefined || end.reply === null
    ? []
    : fleet.filter((v) => {
        const reply = end.reply as string
        return reply.includes(v.model) || reply.includes(`${v.make} ${v.model}`)
      })

  /**
   * The car they just picked, in their own words.
   *
   * Ahead of the reply, because "Rolls-Royce Cullinan, please." is the customer
   * naming a car and the reply mentioning one is an inference about it. Both
   * usually agree; when they do not, theirs is the one that counts.
   */
  const chosen = carChosenIn(context.message.body, fleet)

  const subject = fleet.length === 1
    ? { make: fleet[0]!.make, model: fleet[0]!.model }
    : chosen !== null
    ? { make: chosen.make, model: chosen.model }
    : namedInReply.length === 1
    ? { make: namedInReply[0]!.make, model: namedInReply[0]!.model }
    // Only when the search found nothing at all. A search that came back with
    // three cars has told us the turn is not about one of them, and narrowing
    // to the single car this customer happens to have seen is worse than
    // having no subject: "show me your cars" answered with the Huracán again,
    // which is what it did live.
    : fleet.length === 0 && asked && photosShown.length === 1
    ? { make: photosShown[0]!.make, model: photosShown[0]!.model }
    : null

  /**
   * A WhatsApp message carries an image or an interactive, never both, so one
   * of them has to lose. It used to be the photographs.
   *
   * That was invisible while the button patterns matched one reply in
   * ninety-eight. Widening them surfaced it immediately: "The Ferrari 488
   * Spider — Giallo Modena yellow, 3.9 L twin-turbo V8, AED 5,000 per day.
   * Still looking at 19th–21st September?" would have lost its four
   * photographs and gained two buttons.
   *
   * The photographs are worth more. A customer who has just picked a car off
   * the list wants to see it; the date question is still there in the words,
   * costs them a short reply, and comes back with buttons on the next turn,
   * when there is nothing to attach. So the gate on `buttons` is gone from
   * here and the buttons are dropped below instead — which also means this
   * decision is made once, where the photographs are known, rather than twice.
   *
   * The list keeps its precedence: a reply inviting a choice between cars is
   * not about one car, and the line-up sends its own pictures alongside.
   */
  const images = subject !== null && offered.list === null
    ? await findVehicleImages(deps.run, {
        operatorId: context.operator.id,
        make: subject.make,
        model: subject.model,
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
        return { photos: [], collage: null }
      })
    : { photos: [], collage: null }

/**
 * How many photographs go out at once.
 *
 * Tested on a real phone rather than reasoned from the documentation, which
 * says only what the API sends and nothing about what the client draws. Three
 * images arrived as three separate bubbles. Seven were collapsed into a single
 * album — the grid WhatsApp shows when a person multi-selects.
 *
 * So there is a threshold, somewhere between four and seven, and beyond it the
 * client does the grouping itself. That is better than any composite we could
 * make: every photograph stays full size, tappable and swipeable, which a
 * flattened grid cannot be.
 *
 * Six, when a car has that many. Enough to cross the threshold, few enough that
 * one car does not fill a phone.
 */
const PHOTOS_PER_CAR = 6

  const seen = images.photos.length === 0
    ? new Set<string>()
    : await photosSentIn(deps.run, {
        conversationId: context.conversation.id,
        operatorId: context.operator.id,
      })

  /**
   * Enough photographs for the client to make an album, or one image holding
   * them when there are not.
   *
   * Above the threshold the individual pictures win outright: WhatsApp groups
   * them itself and each stays full size and tappable. Below it they arrive as
   * separate bubbles, and a handful of loose images looks less considered than
   * one composed picture — which is what the collage is for.
   *
   * Five, measured rather than reasoned. Two images did not group. Three did
   * not. Seven did. Count is the mechanism and not timing: the two were sent
   * back to back and would have grouped if arrival spacing were what mattered.
   *
   * The picker grouping two photographs is a different code path — it marks
   * them as one send, which the API gives no way to do.
   */
  const ALBUM_FORMS_AT = 5
  const candidates = images.photos.length >= ALBUM_FORMS_AT || images.collage === null
    ? images.photos
    : [images.collage]
  const unseen = candidates.filter((url) => !seen.has(url))

  /**
   * The model saying pictures are attached counts as asking for them.
   *
   * The prompt forbids it precisely so that a suppressed photograph stays
   * invisible. Live it said "I've attached the photos here" on a turn that
   * attached nothing, and the customer was left looking for them.
   *
   * Arguing with the model is not available — the reply is already written and
   * rewriting it is not something this system does. What is available is making
   * the sentence true. So a claimed attachment sends the photographs, even
   * when the customer never used the word.
   *
   * Recorded as a defect either way. A turn reaching this line means the model
   * broke a rule the instructions state plainly, and that is worth knowing
   * about however gracefully it is handled.
   */
  const claimed = photosPromisedIn(end.reply)
  if (claimed) {
    console.error(JSON.stringify({
      event: 'photos.claimed_in_reply',
      conversationId: context.conversation.id,
      promptVersion: PROMPT_VERSION,
      candidates: candidates.length,
      alreadyAsked: asked,
    }))
  }

  /**
   * Whether this customer has seen this car — not whether they have seen any.
   *
   * The unprompted send used to be gated on `seen.size === 0`: photographs go
   * out once, on the first reply that has any, and never again unasked. That
   * reads as "do not spam them" and behaves as "only the first car in a
   * conversation is ever shown".
   *
   * Live: a customer picked the Ferrari off the list, having been sent the
   * Lamborghini an hour before, and got a paragraph of description with no
   * picture — because `seen` was not empty. Every car after the first was
   * invisible for the rest of the conversation.
   *
   * The rule that was meant is per car, and `unseen` already knows: a car whose
   * photographs are all still unsent is one this customer has not been shown.
   */
  const carIsNewToThem = candidates.length > 0 && unseen.length === candidates.length

  const showing = asked || claimed
    ? (unseen.length > 0 ? unseen : candidates).slice(0, PHOTOS_PER_CAR)
    : (carIsNewToThem ? candidates.slice(0, PHOTOS_PER_CAR) : [])

  /**
   * When the answer is "I sent those earlier", say it attached to the message
   * that did.
   *
   * Meta calls this a contextual reply: the quoted message appears in a bubble
   * above the new one, and tapping it scrolls there. It is the difference
   * between telling a customer the photographs are somewhere above and handing
   * them the photographs.
   *
   * Only when nothing is going out this turn — a reply carrying pictures does
   * not need to point at older ones — and only when they asked. An unprompted
   * quote of a week-old message is a bot demonstrating that it has a memory.
   */
  /**
   * The message that carried this car's photographs — not the last car's.
   *
   * photosShown is ordered most-recent-first, and quoting `[0]` quotes whatever
   * car was shown last. Shown the Lamborghini and then the Cullinan, "can I see
   * the lambo again" would have pointed at the Rolls-Royce.
   */
  const shownBefore = subject === null
    ? photosShown[0]
    : photosShown.find((v) => v.make === subject.make && v.model === subject.model)

  /**
   * Picking a car counts as asking, when they have already seen it.
   *
   * The gate was `asked` alone, on the reasoning that an unprompted quote of a
   * week-old message is a bot demonstrating it has a memory. True of a car
   * nobody mentioned; not true of the one they just chose off the list, where
   * the photographs are the thing they are about to look for.
   */
  const quoting = showing.length === 0 && (asked || chosen !== null) && shownBefore !== undefined
    ? shownBefore.lastMessageId
    : null

  /**
   * The line-up of one photograph per car is gone.
   *
   * It was built because "show me your cars" answering with a tappable list of
   * names and no pictures is a catalogue nobody reads, and that reasoning was
   * sound for a fleet of three. It does not survive a fleet of a hundred:
   * capped at six it still puts six image bubbles under one question, and the
   * operator this is for may have thirty cars.
   *
   * The list is the browse and a photograph is the detail view. Picking a car
   * off the list already sends that car's pictures, so the photographs arrive
   * at the moment somebody has shown they want to look — one car, every angle,
   * instead of six cars and one angle each.
   *
   * findFleetShowcase went with it rather than staying as a query nothing
   * calls. It is in the history if a small operator ever wants the line-up
   * back, behind a fleet-size gate.
   */

  /**
   * A way out, for the customer a conversation cannot hold.
   *
   * Attached because the reply already offered it, not because we decided to:
   * the model judges that the fleet is bigger than the thread and says so, and
   * this makes the sentence true — the same shape as a claimed photograph.
   *
   * Nothing happens without an operator website, and the reply then reads as
   * an ordinary sentence rather than a broken promise, which is the right
   * failure. A link is an exit: tested, the button opens the phone's default
   * browser as a separate app, so it costs the conversation and is worth it
   * only when they asked for more than the conversation has.
   */
  const website = usableWebsite(context.operator.websiteUrl)
  const link = website !== null && offersTheFullRange(end.reply)
    ? { label: FULL_RANGE_LABEL, url: website }
    : null

  const accepted = await acceptTurnOutput(deps.transact, {
    conversationId: context.conversation.id,
    operatorId: context.operator.id,
    revisionAtTurnStart,
    /**
     * Repaired on the way out, not argued about in the instructions.
     *
     * v12 lets the model use WhatsApp's formatting, and a model told it may
     * use bold reaches for Markdown's two asterisks, which arrive visible.
     * This fixes that and the three other near-misses and leaves every other
     * character alone — a reply is a person's words, and rewriting them is not
     * something this system does.
     */
    body: asWhatsAppText(end.reply as string),
    /**
     * Two closed questions get a tap instead of a typed answer. Everything
     * else — which is nearly everything — goes as plain text, because a menu
     * on an open question is the fixed-flow bot this is not.
     *
     * Dropped when photographs are going out, because one message cannot hold
     * both and the picture of the car is the better half of that trade.
     */
    replyButtons: offered.list === null && showing.length === 0 ? offered.buttons : null,
    replyList: offered.list,
    /**
     * The reply carries the first photograph when there is one — except when
     * it carries a list or buttons, which an image message cannot hold. In
     * that case every picture follows as its own message.
     */
    replyImageUrl: showing[0] ?? null,
    // Further photographs of a car the reply has already named, so no caption.
    extraImages: showing.slice(1).map((url) => ({ url })),
    quotesMessageId: quoting,
    replyLink: link,
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
  /**
   * What this turn established about the enquiry, written down whether or not
   * the model remembered to.
   *
   * Five days into a ninety-four message conversation the enquiry still said
   * "Lamborghini Huracán Tecnica, 16 September to 5 October, 20 days" —
   * recorded in a two-minute burst on the first evening and never touched
   * again, while the customer had since asked for a Cullinan and said there
   * were five of them. Seven turns out of forty-seven recorded anything at
   * all.
   *
   * That matters because prepare_quote prices from these fields. A quote asked
   * for today would have been a Huracán for twenty days, for somebody who
   * wanted an SUV for five people.
   *
   * So the car the turn was demonstrably about is recorded here, in code, and
   * the tool stays for everything a conversation says that a turn cannot
   * observe — a budget, a preference, who the rental is for. Same division as
   * the discount rule and the photographs: the model's memory is a courtesy
   * and the write is the guarantee.
   *
   * `recordFields` supersedes rather than overwrites, so a customer who moves
   * from the Huracán to the Cullinan leaves both rows and a correction that
   * can be read back.
   */
  /**
   * Only when the customer settled on it, or when nothing was on file.
   *
   * The first version of this recorded whichever car the turn was about, and
   * watching it run was the correction: across four messages the enquiry went
   * Huracán, Cullinan, then back to Huracán — the last because somebody asked
   * "it's popular as compared to lambo?" and the lambo got looked up. A
   * comparison is not a choice and a car the agent mentions is not a car the
   * customer picked.
   *
   * Thrashing is worse than the staleness it was meant to fix. A stale value
   * is at least something the customer once said; a thrashed one is whichever
   * car came up last, and prepare_quote prices from it.
   *
   * So: their own words settling on one car, or filling a field nobody has
   * filled. Everything else waits for the model to say so through the tool,
   * which is the right place for a judgement that needs reading a sentence.
   */
  const onFile = await getEnquiryFields(deps.run, context.operator.id, enquiryId)
    .catch(() => [])

  const settledOn = carChosenIn(context.message.body, fleet)
  const noVehicleYet = !onFile.some((f) => f.field === 'vehicle')
  const vehicleToRecord = settledOn !== null
    ? `${settledOn.make} ${settledOn.model}`
    : noVehicleYet && subject !== null
    ? `${subject.make} ${subject.model}`
    : null

  if (vehicleToRecord !== null) {
    await recordFields(deps.transact, {
      operatorId: context.operator.id,
      enquiryId,
      observations: [{
        field: 'vehicle',
        value: vehicleToRecord,
        sourceMessageId: context.message.id,
        verificationState: settledOn !== null ? 'customer_stated' : 'system_verified',
      }],
    }).catch((error: unknown) => {
      console.error(JSON.stringify({
        event: 'enquiry_fields.autorecord_failed',
        conversationId: context.conversation.id,
        error: error instanceof Error ? error.message : String(error),
      }))
      return []
    })
  }

  /**
   * And the stage the enquiry has plainly reached.
   *
   * Nothing advanced it before: the only code that wrote sales_stage was the
   * manual won/lost close-out, so every conversation sat at 'new' however far
   * it had got — which made the qualification rate on the reports page
   * structurally zero.
   */
  await advanceStage(deps.run, {
    operatorId: context.operator.id,
    conversationId: context.conversation.id,
    stage: stageFromEvidence({
      fields: onFile,
      quoteSent: end.toolResults.some(
        (r) => r.name === 'prepare_quote' && r.result.status === 'ok',
      ),
      optionsSent: fleet.length > 0,
    }),
  }).catch((error: unknown) => {
    console.error(JSON.stringify({
      event: 'sales_stage.advance_failed',
      conversationId: context.conversation.id,
      error: error instanceof Error ? error.message : String(error),
    }))
    return { moved: false, from: null }
  })

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

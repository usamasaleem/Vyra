import { createHash } from 'node:crypto'
import {
  asksToSeePhotos, asWhatsAppText, isOnlyAGreeting, buttonsFor, photosPromisedIn, detectDiscountRequest,
  type AutomatedMessage, BOOKING_CONFIRMATION, BOOKING_NOW, BOOKING_NOW_OR_HOLD, carChosenIn, civilDateIn,
  DELIVERY_CHOICE,
  formatCivil, surfaceForAsking,
  FULL_RANGE_LABEL, isOpenAt, readServiceHours, type StopCode, mightNeedAvailability,
  wantsToBook, asksToBook, invitesACarChoice, mightNeedTheFleet, offersAChoice, offersTheFullRange,
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
import { checkReplyFacts, rewriteReply, searchVehicles, SYSTEM_PROMPT } from '@vyra/agent'
import {
  acceptTurnOutput,
  ASK_FOR,
  activeBookingFor,
  bookingChecklist,
  customerHistory,
  recordBookingProgress,
  activeHoldFor,
  BEFORE_HANDOVER,
  DOCUMENTS_WANTED,
  fileWaitingDocuments,
  queueOutboundText,
  renderBookingSummary,
  nextQuestion,
  summaryKey,
  fileBookingDocument,
  bookingsOnFile,
  currentQuoteFor,
  ensureEnquiry,
  formatMoneyMinor,
  liveEnquiries,
  recordAgentRun,
  recordFields,
  carsWithoutPhotos,
  ENQUIRY_FIELDS,
  getApprovedAnswer,
  vehiclesConsidered,
  getEnquiryFields,
  unclaimedHandoffFor,
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
  | {
      outcome: 'needs_a_person'
      reason: 'non_text_message' | 'safety_or_accident' | 'payment_or_dispute'
    }
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
/**
 * A photo sent for a booking is a document, not a mystery.
 *
 * Every photo used to become a handoff — "I can't view images, so a colleague
 * will take a look" — which is right for a picture of a scratch and a dead end
 * for the licence the agent had just asked for. When the customer has a
 * confirmed booking that is still waiting on documents, a photo or a file is
 * filed against it and acknowledged, and the conversation carries on without
 * anybody being paged.
 *
 * Nothing here reads the image. Whether it is a licence, a passport or a
 * picture of their lunch is a person's to see when they check the booking;
 * the acknowledgement says so rather than pretending otherwise.
 *
 * Returns null when this is not that case, and the ordinary handoff runs.
 */
const DOCUMENT_KINDS = new Set(['image', 'document'])

export async function fileDocumentIfBooked(
  deps: Pick<TurnDependencies, 'run' | 'transact' | 'destination'>,
  context: ConversationContext,
): Promise<TurnResult | null> {
  if (!DOCUMENT_KINDS.has(context.message.kind)) return null

  const bookingId = await activeBookingFor(deps.run, {
    operatorId: context.operator.id, conversationId: context.conversation.id,
  })
  if (bookingId === null) return null

  const before = await bookingChecklist(deps.run, { operatorId: context.operator.id, bookingId })
  if (before === null) return null

  /**
   * The documents are in and they are paying by transfer or link: a picture
   * now is the screenshot they were asked for. Simulated: "please send a
   * screenshot once it is done", the customer did, and was told "I can't view
   * images, a colleague will take a look" — a handoff for exactly what the
   * agent had asked them to send. It is recorded as them saying they paid,
   * which is what a screenshot is; a person still checks the account.
   */
  if (!before.missing.includes('documents')) {
    /**
     * Documents in, and not paying by transfer or link: another picture is
     * still about this booking — a second angle of the licence, a visa page.
     * Live: a third photo got "I can't view images, a colleague will take a
     * look", a handoff, and then silence. It is filed with the others and the
     * booking carries on.
     */
    if (before.owedMinor === 0 || (before.paymentPlan !== 'transfer' && before.paymentPlan !== 'link')) {
      await fileBookingDocument(deps.run, {
        operatorId: context.operator.id, bookingId,
        conversationId: context.conversation.id, messageId: context.message.id,
      })
      const ask = nextQuestion(before)
      const filed = await acceptTurnOutput(deps.transact, {
        conversationId: context.conversation.id,
        operatorId: context.operator.id,
        revisionAtTurnStart: context.conversation.revision,
        body: `Got it — that is on your booking too.${ask === null ? '' : ` ${ask}`}`,
        replyButtons: before.missing[0] === 'handover_choice' ? DELIVERY_CHOICE : null,
        idempotencyKey: `document:${context.message.id}`,
        destination: deps.destination,
      })
      if (!filed.accepted) return { outcome: 'rejected', reason: String(filed.reason) }
      return filed.destination === 'send'
        ? { outcome: 'queued', messageId: filed.queued.messageId }
        : { outcome: 'drafted', noteId: filed.noteId }
    }
    await recordBookingProgress(deps.run, {
      operatorId: context.operator.id, bookingId, saysPaid: true,
    })
    const thanked = await acceptTurnOutput(deps.transact, {
      conversationId: context.conversation.id,
      operatorId: context.operator.id,
      revisionAtTurnStart: context.conversation.revision,
      body: 'Thanks — I have put that on your booking as the payment. The team will confirm it arrived.',
      idempotencyKey: `payment-screenshot:${context.message.id}`,
      destination: deps.destination,
    })
    if (!thanked.accepted) return { outcome: 'rejected', reason: String(thanked.reason) }
    return thanked.destination === 'send'
      ? { outcome: 'queued', messageId: thanked.queued.messageId }
      : { outcome: 'drafted', noteId: thanked.noteId }
  }

  await fileBookingDocument(deps.run, {
    operatorId: context.operator.id,
    bookingId,
    conversationId: context.conversation.id,
    messageId: context.message.id,
  })
  // And any that arrived alongside it, whose own jobs gave way to this one.
  const { total } = await fileWaitingDocuments(deps.run, {
    operatorId: context.operator.id,
    bookingId,
    conversationId: context.conversation.id,
  })

  const after = await bookingChecklist(deps.run, { operatorId: context.operator.id, bookingId })
  const next = after?.missing[0]
  const ask = after === null ? null : nextQuestion(after)

  /**
   * Which ID, from what they told us. "Passport or Emirates ID" to somebody
   * who has just said they are visiting names a card they cannot have.
   */
  const [lives] = await deps.run(
    `select fe.value from field_evidence fe
     join bookings b on b.enquiry_id = fe.enquiry_id and b.operator_id = fe.operator_id
     where b.id = $1 and b.operator_id = $2 and fe.field = 'residency' and fe.superseded_at is null
     order by fe.created_at desc limit 1`,
    [bookingId, context.operator.id],
  ).catch(() => [])
  const residency = String(lives?.['value'] ?? '').toLowerCase()
  // "Non-resident" contains "resident"; the visitor test goes first.
  const identity = /visit|tourist|non[- ]?resident|not (?:a )?resident/.test(residency)
    ? 'your passport'
    : residency.includes('resident') ? 'your Emirates ID' : 'your passport or Emirates ID'

  const body = total < DOCUMENTS_WANTED
    ? 'Got it — I have added that to your booking. Could you send the other one too? We need '
      + `your driving licence and ${identity}. The team checks them before the handover.`
    : 'Got it — that is both, and they are on your booking. The team checks them before the handover.'
      + (ask === null || next === 'documents' ? '' : ` ${ask}`)

  const accepted = await acceptTurnOutput(deps.transact, {
    conversationId: context.conversation.id,
    operatorId: context.operator.id,
    revisionAtTurnStart: context.conversation.revision,
    body,
    // The one closed question this can end on gets its tap.
    replyButtons: total >= DOCUMENTS_WANTED && next === 'handover_choice' ? DELIVERY_CHOICE : null,
    idempotencyKey: `document:${context.message.id}`,
    destination: deps.destination,
  })

  // The photo is filed whether or not the acknowledgement survives: a newer
  // message overtaking it is the turn's business, not the document's.
  if (!accepted.accepted) return { outcome: 'rejected', reason: String(accepted.reason) }
  // The second photo is often the last thing the booking was waiting for.
  if (accepted.destination === 'send') {
    await sendBookingSummaryIfComplete(deps, {
      operatorId: context.operator.id, conversationId: context.conversation.id, bookingId,
    }).catch(() => undefined)
  }
  return accepted.destination === 'send'
    ? { outcome: 'queued', messageId: accepted.queued.messageId }
    : { outcome: 'drafted', noteId: accepted.noteId }
}

/**
 * Everything about the booking, in one message, once it is all there.
 *
 * Until now the details arrived across a dozen messages — the price in one,
 * the time three later, the address after that — and nothing ever put them
 * back together. A customer checking what they had agreed to scrolled. This is
 * sent when the last thing the handover needs arrives, rendered from the
 * record so it cannot disagree with it.
 *
 * Once per plan: a changed time or address sends an updated one, a payment
 * being marked taken does not. Only where replies are being sent — in draft
 * mode nothing reaches a customer without a person, and this is no exception.
 */
export async function sendBookingSummaryIfComplete(
  deps: Pick<TurnDependencies, 'run' | 'destination'>,
  input: { operatorId: string; conversationId: string; bookingId: string },
): Promise<boolean> {
  if (deps.destination !== 'send') return false
  const list = await bookingChecklist(deps.run, {
    operatorId: input.operatorId, bookingId: input.bookingId,
  })
  if (list === null || list.returnedAt !== null) return false
  /**
   * Payment counts once they have chosen how. Waiting for "I've paid" held the
   * summary back from everybody paying by link or transfer — the customers who
   * most need the amount and the booking in one place.
   */
  const waiting = list.missing.filter((m) => BEFORE_HANDOVER.includes(m)
    && !(m === 'payment' && list.paymentPlan !== null))
  if (waiting.length > 0) return false

  const collectionPoint = list.handover === 'collection'
    ? (await getApprovedAnswer(deps.run, input.operatorId, 'collection-point'))?.answer ?? null
    : null
  await queueOutboundText(deps.run, {
    conversationId: input.conversationId,
    operatorId: input.operatorId,
    body: renderBookingSummary(list, { collectionPoint }),
    idempotencyKey: `booking-summary:${createHash('sha256').update(summaryKey(list)).digest('hex').slice(0, 24)}`,
  })
  return true
}

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

/**
 * What a customer hears when a rule decided a person must handle this.
 *
 * Written per code rather than one sentence, because the three are not the
 * same event. Somebody reporting a crash needs to hear that help is coming,
 * not that their message has been filed.
 *
 * None of them apologise on the operator's behalf or concede anything: the
 * commercial and legal position belongs to a person, and a machine conceding
 * it in the first thirty seconds is its own kind of harm.
 */
const URGENT_ACKNOWLEDGEMENT: Record<StopCode, string> = {
  accident: "I'm getting a colleague onto this right now. If anyone is hurt or the car is unsafe, "
    + 'call the emergency services first on 999 — they matter more than this conversation.',
  payment_dispute: "Thanks for telling me — I'm passing this to a colleague who can look at the "
    + 'account properly. They will come back to you.',
  complaint: "Thank you for raising it — I'm passing this to a colleague who can look into it "
    + 'properly. They will come back to you.',
  human: 'Putting you through to a colleague now.',
  discount: 'Let me get a colleague to look at that for you.',
}

/**
 * Which queue this lands in.
 *
 * Not a priority: PRIORITY_FOR in handoff-queue.ts derives that from the
 * reason, and both of these are already 'urgent' there.
 */
const URGENT_HANDOFF_REASON: Record<StopCode, 'safety_or_accident' | 'payment_or_dispute'> = {
  accident: 'safety_or_accident',
  payment_dispute: 'payment_or_dispute',
  complaint: 'payment_or_dispute',
  human: 'payment_or_dispute',
  discount: 'payment_or_dispute',
}

/**
 * A message a rule stopped before the model ever saw it.
 *
 * Deliberately the same shape as handleNonTextMessage: acknowledge honestly,
 * raise a real task, and let the one acknowledgement through at the
 * post-handoff revision. Silence after "I've had an accident" would be the
 * worst thing this system could do, and holding the turn without this would
 * produce exactly that.
 *
 * `urgent` priority rather than the default. The queue already sorts by it,
 * and this is what it is for.
 */
export async function handleUrgentMessage(
  deps: Pick<TurnDependencies, 'run' | 'transact' | 'destination'>,
  context: ConversationContext,
  urgent: { code: StopCode; matched: string; why: string },
): Promise<TurnResult> {
  const summary = `${urgent.why} — the customer said "${urgent.matched}". `
    + 'Stopped before the agent replied; read the message and take this yourself.'

  await requestHandoff(deps.run, {
    conversationId: context.conversation.id,
    operatorId: context.operator.id,
    reason: summary,
  })

  await raiseHandoff(deps.run, {
    operatorId: context.operator.id,
    conversationId: context.conversation.id,
    reason: URGENT_HANDOFF_REASON[urgent.code],
    summary,
    // Priority is not passed: PRIORITY_FOR in handoff-queue.ts already maps
    // both of these to 'urgent', and it is deliberately the one place that
    // judgement is made.
    triggerMessageId: context.message.id,
  })

  await acceptTurnOutput(deps.transact, {
    conversationId: context.conversation.id,
    operatorId: context.operator.id,
    revisionAtTurnStart: context.conversation.revision,
    body: URGENT_ACKNOWLEDGEMENT[urgent.code],
    idempotencyKey: `urgent:${context.message.id}`,
    destination: deps.destination,
    ownHandoff: true,
  })

  return { outcome: 'needs_a_person', reason: URGENT_HANDOFF_REASON[urgent.code] }
}

/**
 * Somebody wrote into a conversation nobody has picked up.
 *
 * The handoff worked: the conversation went to a person, the queue has it,
 * the SLA is running. What nothing covered is the customer, who had just been
 * told "I've connected you with an agent" and then asked which colours were
 * available — and got nothing, and asked again, and again, five times in five
 * minutes while ai_resumes_after_minutes counted down.
 *
 * One line, once per handoff. Not an answer: a person owns the decision and
 * section 10 is right that two handlers are worse than one. But "a colleague
 * has this" costs nothing and is the difference between a queue and a void.
 *
 * Once per silence rather than once per handoff, which is what it was for a
 * few hours and was too stingy by a long way. A customer was told at 05:51
 * that a colleague had it, came back at 11:13 to a handoff still nobody's, and
 * got nothing — five hours later, on the grounds that the same handoff had
 * already been acknowledged. Once in a sitting is right. Once in a day is a
 * different thing wearing the same rule.
 *
 * So the test is whether anything has been said to them recently, not whether
 * this task has ever been mentioned. That makes it self-limiting without a
 * counter: the acknowledgement is itself an outbound message, so a burst of
 * four gets one and the other three see it and stay quiet.
 */
const QUIET_FOR_MINUTES = 30

export async function acknowledgeWaiting(
  deps: Pick<TurnDependencies, 'run' | 'transact' | 'destination'>,
  context: ConversationContext,
): Promise<TurnResult> {
  const unclaimed = await unclaimedHandoffFor(deps.run, {
    conversationId: context.conversation.id,
    operatorId: context.operator.id,
  }).catch(() => null)

  // No unclaimed handoff means a person is present, or took it over
  // deliberately. Either way this is not the silence to fill.
  if (unclaimed === null) return { outcome: 'skipped', reason: 'no_message_body' }

  /**
   * Anything at all in the last half hour counts, including a salesperson's
   * own reply. If somebody has just spoken to them, they are not being
   * ignored, and saying "a colleague has this" on top of it is noise.
   */
  const recent = await deps.run(
    `select 1 from messages
     where conversation_id = $1 and operator_id = $2 and direction = 'outbound'
       and created_at > now() - make_interval(mins => $3)
     limit 1`,
    [context.conversation.id, context.operator.id, QUIET_FOR_MINUTES],
  ).catch(() => [])
  if (recent.length > 0) return { outcome: 'rejected', reason: 'already_acknowledged' }

  const accepted = await acceptTurnOutput(deps.transact, {
    conversationId: context.conversation.id,
    operatorId: context.operator.id,
    revisionAtTurnStart: context.conversation.revision,
    body: 'A colleague has this one and will come back to you shortly — '
      + "I've let them know you're waiting.",
    // Per message, which the quiet check above makes safe: a second message
    // arriving behind this one sees the acknowledgement and says nothing.
    idempotencyKey: `waiting:${context.message.id}`,
    destination: deps.destination,
    ownHandoff: true,
  })

  // Not accepted means the idempotency key already exists: this handoff has
  // been acknowledged, which is the point.
  return accepted.accepted
    ? { outcome: 'queued', messageId: null }
    : { outcome: 'rejected', reason: 'already_acknowledged' }
}

/**
 * The two messages the operator writes and the system sends on its own.
 *
 * Neither is composed, guessed or defaulted. An operator who has not written a
 * greeting has no greeting, and nothing goes out — the same rule as a policy
 * answer, for the same reason: this is their voice, not ours, and inventing it
 * is the mistake that took a day to undo.
 *
 * Sent as their own message before the agent's reply, rather than folded into
 * it. The operator's words and the model's words in one bubble is neither
 * person speaking.
 */
async function sendWrittenMessage(
  deps: Pick<TurnDependencies, 'run' | 'transact' | 'destination'>,
  context: ConversationContext,
  topic: AutomatedMessage,
  idempotencyKey: string,
  now: Date,
): Promise<boolean> {
  const written = await getApprovedAnswer(deps.run, context.operator.id, topic, now)
    .catch(() => null)
  if (written === null) return false

  const accepted = await acceptTurnOutput(deps.transact, {
    conversationId: context.conversation.id,
    operatorId: context.operator.id,
    revisionAtTurnStart: context.conversation.revision,
    body: written.answer,
    idempotencyKey,
    destination: deps.destination,
    // Not an answer to this message, and it must not be discarded when a
    // second one arrives behind it: a greeting is about the person, not the
    // question.
    ownHandoff: true,
  })
  return accepted.accepted
}

/**
 * Said once to each person, ever.
 *
 * Keyed on the contact rather than the conversation, because a conversation
 * reopens for years — being welcomed again in March is being told you are a
 * stranger.
 */
export async function greetIfNew(
  deps: Pick<TurnDependencies, 'run' | 'transact' | 'destination'>,
  context: ConversationContext,
  now: Date = new Date(),
): Promise<boolean> {
  /**
   * Only for somebody who opened with a hello, and only on that first message.
   * A customer who opened with a question is answered instead; the same person
   * saying "hi" three messages later is not new, and a welcome then is a
   * stranger's.
   */
  if (!isOnlyAGreeting(context.message.body)) return false
  const [earlier] = await deps.run(
    `select 1 from messages m
     join conversations v on v.id = m.conversation_id and v.operator_id = m.operator_id
     where v.contact_id = $1 and v.operator_id = $2
       and m.direction = 'inbound' and m.id <> $3
     limit 1`,
    [context.contact.id, context.operator.id, context.message.id],
  )
  if (earlier !== undefined) return false

  return sendWrittenMessage(deps, context, 'greeting', `greeting:${context.contact.id}`, now)
}

/**
 * Said when they write and nobody is in.
 *
 * The agent still answers — it is the people who are away, not the system — so
 * this is about what happens to anything needing one of them.
 *
 * Once per closed spell rather than once per message: somebody writing three
 * times at two in the morning is not told three times that the office is shut.
 * The key is the operator's own local date, which is the cheapest thing that
 * changes when a night ends.
 */
export async function noticeOutOfHours(
  deps: Pick<TurnDependencies, 'run' | 'transact' | 'destination'>,
  context: ConversationContext,
  now: Date = new Date(),
): Promise<boolean> {
  const hours = readServiceHours(context.operator.serviceHours)
  if (isOpenAt(hours, now, context.operator.timezone)) return false

  const localDate = formatCivil(civilDateIn(now, context.operator.timezone))
  return sendWrittenMessage(
    deps, context, 'out-of-hours', `out-of-hours:${context.conversation.id}:${localDate}`, now,
  )
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
  /** Empty means the enquiry has everything section 3 asks for. */
  let nothingOutstanding = false
  /**
   * What the booking needs that only a person can supply, because the operator
   * has not written it down. Raised as visible work after the reply is accepted.
   */
  let gapsForAPerson: string[] = []

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

    /**
     * Every car this enquiry has been about.
     *
     * The live vehicle answers "which car is this rental for". This answers
     * the one nothing could: which cars are they weighing up. Derived from the
     * evidence they have already given, so there is nothing new to keep in
     * step.
     */
    const considering = await vehiclesConsidered(deps.run, context.operator.id, enquiryId)
      .catch(() => [] as string[])

    /**
     * Every rental in this thread, when there is more than one.
     *
     * A nicety like the rest: without it the turn is exactly what it was, a
     * conversation about one car. With it, two rentals stay two rentals.
     */
    const bookings = await liveEnquiries(deps.run, context.operator.id, context.conversation.id)
      .then((all) => all.map((b) => ({
        enquiryId: b.enquiryId,
        vehicle: b.vehicle,
        known: [...b.fields]
          .sort((a, c) => ENQUIRY_FIELDS.indexOf(a.field) - ENQUIRY_FIELDS.indexOf(c.field))
          .map((f) => ({ field: f.field as string, value: f.value, since: f.extractedAt })),
      })))
      .catch((error: unknown) => {
        console.error(JSON.stringify({
          event: 'live_enquiries.failed',
          conversationId: context.conversation.id,
          error: error instanceof Error ? error.message : String(error),
        }))
        return []
      })

    /**
     * The price already on the table, so a yes can find it.
     *
     * A nicety like the rest: without it the model is back to only knowing a
     * quote it produced itself this turn, which is how a discounted price and
     * a customer's agreement to it stopped being the same number.
     */
    const liveQuote = await currentQuoteFor(deps.run, {
      operatorId: context.operator.id,
      enquiryId,
    }).then((q) => q === null ? undefined : {
      quoteId: q.quoteId,
      total: formatMoneyMinor(q.totalMinor, q.currency),
      discounted: q.discountMinor !== null,
      sent: q.sent,
    }).catch((error: unknown) => {
      console.error(JSON.stringify({
        event: 'live_quote.failed',
        conversationId: context.conversation.id,
        error: error instanceof Error ? error.message : String(error),
      }))
      return undefined
    })

    /**
     * What they have to bring, for the moment they commit.
     *
     * "Booked — someone from the team will be in touch with the remaining
     * details" is where this product stopped: a customer who has just agreed
     * to pay is told, in effect, to wait for a phone call. The requirements
     * have been a publishable policy answer all along and nothing ever
     * reached for them.
     *
     * Fetched when somebody is at the point of committing rather than after,
     * because whether the booking lands is decided inside the tool partway
     * through the turn — by then the prompt is already written.
     *
     * Which one depends on where they live, which the enquiry records when
     * they have said. When they have not, both go over and the model asks —
     * one short question at the point of sale is what a salesperson does, and
     * it beats reciting a visitor's paperwork to a resident.
     */
    /**
     * Whenever a price is on the table, not only when their words match.
     *
     * This used to hang on wantsToBook, an English pattern. Read live: the
     * customer answered the price with "yeds". The model understood it and
     * booked the car; the pattern did not, so the requirements never came
     * along and the reply ended "someone from the team will be in touch".
     * The instruction is conditional — used only if the booking actually
     * lands — so passing it early costs one read and nothing else.
     */
    const aboutToCommit = wantsToBook(context.message.body)
      || context.conversation.bookingStatus === 'pending'
      || liveQuote !== undefined

    /**
     * Somebody who has rented before. Read every turn: cheap, and it is what
     * stops the agent asking a regular for the licence it checked last month.
     */
    const history = await customerHistory(deps.run, {
      operatorId: context.operator.id, contactId: context.contact.id,
    }).catch(() => null)
    const returning = history === null || history.rentals.length === 0 ? undefined : {
      rentals: history.rentals.map((r) => {
        const month = new Intl.DateTimeFormat('en-GB', { month: 'long', timeZone: 'UTC' })
          .format(new Date(`${r.startDate}T12:00:00Z`))
        return `the ${r.vehicle ?? 'car'} in ${month}`
      }),
      documentsOnFile: history.documentsCheckedAt !== null,
      residency: history.residency,
      lastAddress: history.rentals.find((r) => r.deliveryAddress !== null)?.deliveryAddress ?? null,
    }

    const bringWithYou = !aboutToCommit ? undefined : await (async () => {
      const residency = (known.find((k) => k.field === 'residency')?.value ?? history?.residency ?? null)
        ?.toLowerCase() ?? null
      const wanted = residency === null
        ? (['driver-requirements-resident', 'driver-requirements-visitor'] as const)
        // "Non-resident" contains "resident", so the visitor test goes first.
        : !/visit|tourist|non[- ]?resident|not (?:a )?resident/.test(residency)
            && residency.includes('resident')
          ? (['driver-requirements-resident'] as const)
          : (['driver-requirements-visitor'] as const)

      const answers = await Promise.all(wanted.map((topic) =>
        getApprovedAnswer(deps.run, context.operator.id, topic, deps.now?.() ?? new Date())))
      const found = answers.filter((a) => a !== null)
      if (found.length === 0) return undefined
      if (found.length === 1) return found[0]!.answer
      return `If they live here: ${found[0]!.answer}\n\nIf they are visiting: ${found[1]!.answer}`
    })().catch((error: unknown) => {
      console.error(JSON.stringify({
        event: 'requirements.lookup_failed',
        conversationId: context.conversation.id,
        error: error instanceof Error ? error.message : String(error),
      }))
      return undefined
    })

    /**
     * What they actually have booked, read fresh every turn. A nicety in the
     * sense that a failure costs a fact rather than the reply — but the fact
     * is the one that stops the agent confirming a booking that was
     * cancelled overnight.
     */
    const onFile = await bookingsOnFile(deps.run, {
      operatorId: context.operator.id,
      conversationId: context.conversation.id,
    }).catch((error: unknown) => {
      console.error(JSON.stringify({
        event: 'bookings_on_file.failed',
        conversationId: context.conversation.id,
        error: error instanceof Error ? error.message : String(error),
      }))
      return undefined
    })

    /**
     * What a confirmed booking still needs, read every turn so the agent can
     * pick up where the last message left off. A nicety: without it the reply
     * still goes, and the customer is back to waiting for a salesperson.
     */
    const afterBooking = await (async () => {
      const bookingId = await activeBookingFor(deps.run, {
        operatorId: context.operator.id, conversationId: context.conversation.id,
      })
      if (bookingId === null) return undefined
      /**
       * A photo answered by a text: "here is the second" sent with the picture
       * is one burst, answered from the text, and the picture's own job never
       * runs. File it before reading what is still missing, or the reply asks
       * for a document the customer is looking at in the chat.
       */
      await fileWaitingDocuments(deps.run, {
        operatorId: context.operator.id, bookingId, conversationId: context.conversation.id,
      })
      const list = await bookingChecklist(deps.run, { operatorId: context.operator.id, bookingId })
      if (list === null) return undefined
      const payment = await getApprovedAnswer(
        deps.run, context.operator.id, 'payment', deps.now?.() ?? new Date())
      const collecting = list.handover !== 'collection'
        ? undefined
        : {
          where: (await getApprovedAnswer(
            deps.run, context.operator.id, 'collection-point', deps.now?.() ?? new Date(),
          ))?.answer ?? null,
        }

      /**
       * The two things the agent has to hand to a person when nobody has
       * written them down: how to pay, and where to collect.
       *
       * Live: "A colleague will send you the payment details" and "I'll send
       * you the exact pickup point" both went out, and neither became anything
       * a colleague could see — "send" was not one of the words the promise
       * check listens for. Decided here from the record rather than from the
       * reply, so it does not depend on how the sentence was phrased.
       */
      const owedNow = list.owedMinor === 0 ? null : formatMoneyMinor(list.owedMinor, list.currency)
      gapsForAPerson = [
        ...(owedNow !== null && list.missing.includes('payment') && payment === null
          && list.paymentLink === null
          ? [`send them how to pay ${owedNow} — nothing is published under Answers for payment, `
            + 'so the agent cannot (Bookings → Attach and send, or publish the payment answer)']
          : []),
        ...(collecting !== undefined && collecting.where === null
          ? [`tell them where to collect the ${list.vehicle ?? 'car'} — no collection point is `
            + 'published under Answers']
          : []),
      ]
      return {
        vehicle: list.vehicle,
        ...(collecting === undefined ? {} : { collecting }),
        missing: list.missing.map((m) => ASK_FOR[m]),
        owed: list.owedMinor === 0 ? null : formatMoneyMinor(list.owedMinor, list.currency),
        paymentInstructions: payment?.answer ?? null,
        paymentLink: list.paymentLink,
      }
    })().catch((error: unknown) => {
      console.error(JSON.stringify({
        event: 'booking_checklist.failed',
        conversationId: context.conversation.id,
        error: error instanceof Error ? error.message : String(error),
      }))
      return undefined
    })

    /**
     * Holding a car for somebody deciding: the operator's length, said the way
     * a person says it, and whatever this conversation holds now — read from
     * the calendar, so a hold that ran out is not described as still standing.
     */
    const holds = context.operator.holdMinutes === null || !context.operator.mayConfirmBookings
      ? undefined
      : await (async () => {
        const minutes = context.operator.holdMinutes!
        const hours = minutes % 60 === 0
          ? `${minutes / 60} hour${minutes === 60 ? '' : 's'}`
          : `${minutes} minutes`
        const held = await activeHoldFor(deps.run, {
          operatorId: context.operator.id, conversationId: context.conversation.id,
        })
        if (held === null) return { hours, active: null }
        const tz = context.operator.timezone
        const civil = (d: Date) => new Intl.DateTimeFormat('en-CA', {
          timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
        }).format(d)
        const time = new Intl.DateTimeFormat('en-GB', {
          timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
        }).format(held.until)
        const now = deps.now?.() ?? new Date()
        return {
          hours,
          active: {
            vehicle: held.vehicle,
            until: civil(held.until) === civil(now) ? `${time} today` : `${time} tomorrow`,
          },
        }
      })().catch(() => undefined)

    /**
     * The minimum age, from the operator's own requirements, for the price.
     *
     * Simulated and certain to happen live: a 22-year-old was quoted, said yes,
     * was booked — and only then read that the driver must be 25. Said with the
     * price, it costs a few words and saves a cancellation.
     */
    const minimumAge = await (async () => {
      const answers = await Promise.all(
        (['driver-requirements-visitor', 'driver-requirements-resident'] as const).map((topic) =>
          getApprovedAnswer(deps.run, context.operator.id, topic, deps.now?.() ?? new Date())),
      )
      const ages = answers
        .map((a) => a?.answer.match(/minimum age(?: for this car)? is (\d{2})\b/i)?.[1])
        .filter((x): x is string => x !== undefined)
        .map(Number)
      return ages.length === 0 ? undefined : Math.max(...ages)
    })().catch(() => undefined)

    const stillNeeded = await outstandingQuestions(deps.run, {
      operatorId: context.operator.id,
      conversationId: context.conversation.id,
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
    nothingOutstanding = stillNeeded.length === 0
    askedThisTurn = stillNeeded.slice(0, 1).map((q) => q.field)
    if (stillNeeded.length > 0) {
      await recordAsked(deps.run, {
        operatorId: context.operator.id,
        conversationId: context.conversation.id,
        asked: stillNeeded.slice(0, 1).map((q) => ({ enquiryId: q.enquiryId, field: q.field })),
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
      ...(bookings.length > 1 ? { bookings } : {}),
      ...(liveQuote === undefined ? {} : { liveQuote }),
      ...(bringWithYou === undefined ? {} : { bringWithYou }),
      mayConfirmBookings: context.operator.mayConfirmBookings,
      ...(onFile === undefined ? {} : { bookingsOnFile: onFile }),
      ...(afterBooking === undefined ? {} : { afterBooking }),
      ...(holds === undefined ? {} : { holds }),
      ...(minimumAge === undefined ? {} : { minimumAge }),
      ...(context.operator.discountTiers.length === 0 ? {} : { discounts: context.operator.discountTiers }),
      ...(returning === undefined ? {} : { returning }),
      ...(context.operator.addOns.length === 0 ? {} : {
        addOns: context.operator.addOns.map((a) =>
          `${a.name} (id "${a.id}"): ${formatMoneyMinor(a.priceMinor, 'AED')} ${a.per === 'day' ? 'a day' : 'per rental'}`),
      }),
      /**
       * The fleet is already in the prompt, so do not offer to look it up.
       *
       * Asking nicely did not work. The instruction said there was no need to
       * call search_vehicles when the answer was already given, and across the
       * pilot the model called it on nineteen of the twenty-four two-round
       * turns where the fleet was sitting in its context — one of them for
       * "Ferrari 488, please." A rewrite measured identically: 22 of 36 turns
       * took a second round either way.
       *
       * So it is withheld rather than discouraged, which is the same move as
       * every other guarantee in this system: the code decides, the prompt is
       * a courtesy. A round is a whole model call, about three and a half
       * seconds of somebody watching a typing indicator.
       *
       * Availability is the exception and stays open, because it is the only
       * thing the tool knows that the prompt does not. The gate is deliberately
       * generous: a false positive costs a round that would have happened
       * anyway, a false negative answers "is it free on the 20th" from a
       * prompt that cannot know.
       */
      ...(prefetched !== undefined && !mightNeedAvailability(context.message.body)
        ? { withoutTools: ['search_vehicles'] as const }
        : {}),
      ...(noPhotosOf.length === 0 ? {} : { noPhotosOf }),
      // Loaded on every turn since this worker was written and never passed on.
      ...(context.contact.displayName == null ? {} : { customerName: context.contact.displayName }),
      // A transcript is a reading of what somebody said, not a record of it.
      ...(context.message.kind === 'audio' ? { spoken: true } : {}),
      // Two cars in play is a comparison, not indecision.
      ...(considering.length < 2 ? {} : { considering }),
      /**
       * The same test the booking buttons use, so the words and the buttons
       * cannot disagree: everything on file, and they have just said yes.
       */
      ...(stillNeeded.length === 0 && wantsToBook(context.message.body)
        ? { readyToConfirm: true }
        : {}),
    })
    /**
     * Read back before it goes. Every amount and percentage in the reply must
     * be in something the agent was given — its instructions, the tools, the
     * conversation — and "booked" or "held" must be true on the record. A
     * reply that fails is rewritten once, with no tools, with the problem
     * named. The prompt asks for this; this is what makes it so.
     */
    let reply = outcome.reply
    if (reply !== null) {
      const okResult = (r: { name: string; result: { status: string } }, name: string) =>
        r.name === name && r.result.status === 'ok'
      const data = (r: { result: unknown }) => (r.result as { data?: Record<string, unknown> }).data ?? {}
      const booked = outcome.toolResults.some((r) => okResult(r, 'request_booking_review') && data(r)['confirmed'] === true)
        || (onFile?.live ?? []).some((b) => b.state === 'confirmed')
      const held = holds?.active != null
        || outcome.toolResults.some((r) => okResult(r, 'hold_car')
          || (okResult(r, 'request_booking_review') && /held for them/.test(String(data(r)['guidance'] ?? ''))))
      const facts = {
        sources: [
          // What was built for this conversation, not the fixed opening: its
          // worked examples carry figures ("can you do 3000…") that would
          // otherwise excuse the same figure invented.
          outcome.system.startsWith(SYSTEM_PROMPT) ? outcome.system.slice(SYSTEM_PROMPT.length) : outcome.system,
          JSON.stringify(outcome.toolResults), context.conversation.summary ?? '',
          ...context.recentMessages.map((m) => m.body ?? ''),
        ],
        booked,
        held,
        // Which year a date is in, and the weekday check, go by the operator's clock.
        today: new Intl.DateTimeFormat('en-CA', {
          timeZone: context.operator.timezone, year: 'numeric', month: '2-digit', day: '2-digit',
        }).format(deps.now?.() ?? new Date()),
      }
      const problems = checkReplyFacts(reply, facts)
      if (problems.length > 0) {
        const rewritten = await rewriteReply(deps.model, {
          system: outcome.system, transcript: outcome.transcript, draft: reply, problems,
        }).catch(() => null)
        const still = rewritten === null ? problems : checkReplyFacts(rewritten, facts)
        console.error(JSON.stringify({
          event: 'fact_check.rewrote', conversationId: context.conversation.id, promptVersion: PROMPT_VERSION,
          problems, resolved: still.length === 0, draft: reply.slice(0, 400),
        }))
        if (rewritten !== null && rewritten.trim() !== '') reply = rewritten
      }
    }

    end = {
      reply,
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

  /**
   * The customer said they want it, and the enquiry has everything.
   *
   * Decided from their message rather than from the reply, unlike every other
   * surface here. Whether to offer this is a fact about what the customer just
   * said, not a judgement about how the model phrased something — and reading
   * intent out of the model's prose with a regex is what has failed repeatedly.
   *
   * Only when nothing is outstanding. Offering to have a booking confirmed
   * before anyone knows the dates is a button that cannot be honoured, and the
   * point of this one is that it can be.
   *
   * What it promises is a person, not a booking, because a person is what
   * exists. See BOOKING_CONFIRMATION.
   */
  /**
   * Whether this turn actually booked it, read from the tool rather than the
   * prose.
   *
   * Live: "Booked — the Ferrari 488 Spider is confirmed for 25th–27th
   * September" went out carrying `Confirm with team` / `Not just yet`. The car
   * was held, the record said confirmed, and the customer was offered two
   * buttons asking whether to start the thing that had already finished. An
   * offer to confirm is only honest while something is unconfirmed.
   */
  // Confirmed or waiting on a colleague: either way the yes is in, and a
  // "Yes, book it" under it asks for what they have just given.
  const bookedThisTurn = end.toolResults.some(
    (r) => r.name === 'request_booking_review' && r.result.status === 'ok',
  )

  const readyToBook = nothingOutstanding
    && wantsToBook(context.message.body)
    && !bookedThisTurn

  /**
   * What the agent was told to ask, which is better evidence than what it
   * wrote.
   *
   * The prose matchers below stay as a fallback — they catch a closed question
   * nobody instructed, which is most date confirmations — but this goes first
   * because it is the instruction rather than an inference about one.
   */
  const fromQuestion = surfaceForAsking(askedThisTurn[0], end.reply)

  /**
   * Buttons that fit what the reply actually asks come first.
   *
   * `readyToBook` used to win outright, and it is a fact about the customer's
   * message rather than about the reply — so a reply that asked "2 rental
   * days, or 3?" went out under `Confirm with team` / `Not just yet`. The
   * customer tapped one, it answered a different question, and the agent asked
   * again. Offering to confirm is only honest when the reply is not itself
   * waiting on an answer.
   */
  const fitsTheReply = buttonsFor(end.reply)

  const offered = {
    buttons: fitsTheReply !== null
      ? fitsTheReply
      : fromQuestion === 'delivery_choice'
      ? DELIVERY_CHOICE
      : (readyToBook && !offersAChoice(end.reply)) || (!bookedThisTurn && asksToBook(end.reply))
      // "Confirm with team" promises a person who is not coming when the
      // agent settles bookings itself.
      ? (context.operator.mayConfirmBookings
        ? (context.operator.holdMinutes !== null ? BOOKING_NOW_OR_HOLD : BOOKING_NOW)
        : BOOKING_CONFIRMATION)
      : null,
    list: fromQuestion === 'car_list' || invitesACarChoice(end.reply)
      ? vehicleList(fleet)
      : null,
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

  // Variant carried through, so a subject used to record a vehicle names the
  // same car the tool would have named.
  const subject = fleet.length === 1
    ? { make: fleet[0]!.make, model: fleet[0]!.model, variant: fleet[0]!.variant }
    : chosen !== null
    ? { make: chosen.make, model: chosen.model, variant: chosen.variant }
    : namedInReply.length === 1
    ? { make: namedInReply[0]!.make, model: namedInReply[0]!.model, variant: namedInReply[0]!.variant }
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

  const bothAtOnce = offered.list === null && offered.buttons !== null && showing.length > 0

  const accepted = await acceptTurnOutput(deps.transact, {
    conversationId: context.conversation.id,
    operatorId: context.operator.id,
    revisionAtTurnStart,
    // Only the ordinary turn passes this. The acknowledgement paths answer an
    // older message on purpose.
    answeringMessageId: context.message.id,
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
    /**
     * Buttons and photographs both, when the reply has both: the pictures go
     * first as their own messages and the question arrives last with its
     * buttons. Live: the first quote — "I can book it now, or hold it for you
     * for 2 hours" — went out as a photo caption, with neither button.
     */
    replyButtons: offered.list === null ? offered.buttons : null,
    replyList: offered.list,
    replyImageUrl: bothAtOnce ? null : showing[0] ?? null,
    // Further photographs of a car the reply has already named, so no caption.
    extraImages: (bothAtOnce ? showing : showing.slice(1)).map((url) => ({ url })),
    imagesFirst: bothAtOnce,
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

  /**
   * The same name the tool records, so the two cannot disagree.
   *
   * `${make} ${model}` drops the variant and "Lamborghini Huracán" then
   * supersedes "Lamborghini Huracán Tecnica", which is the same car. The fleet
   * row has the variant; use it.
   */
  const fullName = (car: { make: string; model: string; variant?: string | null }) =>
    [car.make, car.model, car.variant].filter((p) => p != null && p !== '').join(' ')

  const settledOn = carChosenIn(context.message.body, fleet)
  const noVehicleYet = !onFile.some((f) => f.field === 'vehicle')
  const vehicleToRecord = settledOn !== null
    ? fullName(settledOn)
    : noVehicleYet && subject !== null
    ? fullName(subject)
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
  /**
   * The operator's standing offer answers it — or gets the first try.
   *
   * Every discount ask used to be a person's, even when the operator had
   * already decided what a week's rental gets. Where they have (Settings →
   * When the price is the objection) and it applied, nobody needs asking. On a
   * first ask it did not reach, the agent offers a cheaper car or the next tier
   * first; a second ask, or wanting more than the tier, is still a person's.
   */
  const standingOfferApplied = end.toolResults.some(
    (r) => r.name === 'offer_discount' && r.result.status === 'ok')
  const askedBefore = context.recentMessages
    .slice(0, -1)
    .some((m) => m.direction === 'inbound' && m.body !== null && detectDiscountRequest(m.body) !== null)
  const firstTryIsTheAgents = context.operator.discountTiers.length > 0 && !askedBefore
  if (discount !== null && !standingOfferApplied && !firstTryIsTheAgents) {
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
      /**
       * A draft price is only waiting on a person where a person approves
       * prices. Where the agent settles bookings itself the customer is quoted
       * the draft and books on it, and "approve or reject a draft quote" was a
       * to-do on every priced conversation that nobody needed to do.
       */
      .filter((call) => !(call.requestedName === 'prepare_quote' && context.operator.mayConfirmBookings))
      .map((call) => call.needsAPerson)
      .filter((item): item is string => item !== null)
      .concat(gapsForAPerson)

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
    /**
     * "The team will confirm once the transfer has arrived" is what the agent
     * is told to say when somebody has paid, and the check it promises already
     * has its place: the booking shows "customer says paid — check the
     * account". Read as a promise of a person, it opened a handoff for every
     * customer who paid.
     */
    const aboutMoneyArriving = (context.conversation.bookingStatus === 'confirmed'
        || end.toolResults.some((r) => r.name === 'record_booking_progress'))
      && /\b(?:arriv|received|land|come through|reflect)/i.test(end.reply ?? '')
    /**
     * A booking waiting for a person is already in front of one — on Bookings,
     * held. "A colleague will confirm it" is the truth about that, and a
     * handoff on top of it was the same request twice in two queues.
     */
    const waitingOnBookings = context.conversation.bookingStatus === 'pending'
      || end.toolResults.some((r) => r.name === 'request_booking_review' && r.result.status === 'ok'
        && (r.result as { data?: { confirmed?: boolean } }).data?.confirmed === false)
    const promised = discount === null && items.length === 0 && !aboutMoneyArriving && !waitingOnBookings
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
   * If this reply was the last thing the booking needed, the whole of it goes
   * next — after the reply, so it reads as the close of the exchange.
   */
  const summarising = await activeBookingFor(deps.run, {
    operatorId: context.operator.id, conversationId: context.conversation.id,
  }).catch(() => null)
  if (summarising !== null) {
    await sendBookingSummaryIfComplete(deps, {
      operatorId: context.operator.id, conversationId: context.conversation.id, bookingId: summarising,
    }).catch((error: unknown) => {
      console.error(JSON.stringify({
        event: 'booking_summary.failed',
        conversationId: context.conversation.id,
        error: error instanceof Error ? error.message : String(error),
      }))
    })
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

'use server'

import { headers } from 'next/headers'
import {
  acceptHandoff,
  addVehicle,
  type AddVehicleProblem,
  addNote,
  answerOperationsRequest,
  approveQuote,
  closeLead,
  discountQuote,
  dismissOperationsRequest,
  rejectQuote,
  listDraftQuotes,
  renderQuoteMessage,
  setVehicleRate,
  setVehicleHighlight,
  addRateSeason,
  removeRateSeason,
  assignConversation,
  queueOutboundText,
  NoDisplayName,
  resumeAi,
  setOperatorAiSending,
  setPriority,
  takeOverConversation,
} from '@vyra/db'
import { complaintAboutImage } from '@vyra/contracts'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { assertPermitted, permissions, requireActor } from '@/lib/auth'
import { actorRunner, actorTransactor } from '@/lib/db'

/**
 * Every action re-derives the actor and its operator from the session.
 *
 * Nothing here trusts a form field to say which operator is being acted on.
 * Section 18.7: a browser-supplied operator id is a requested scope, not proof
 * of permission — and a hidden input is exactly the browser supplying one.
 */

export async function sendReply(
  _previous: { error: string | null },
  formData: FormData,
): Promise<{ error: string | null }> {
  const actor = await requireActor()
  const conversationId = String(formData.get('conversationId') ?? '')
  const body = String(formData.get('body') ?? '').trim()

  if (body === '') return { error: 'Write something first.' }

  try {
    assertPermitted(permissions.canReply(actor), 'send a customer reply')
  } catch {
    return { error: 'Your role cannot send customer replies.' }
  }

  /**
   * Staff messages take the same path as AI messages — queued here, sent by
   * the dispatcher. Section 18.12 forbids a second way to send, because a
   * direct call would skip the 24-hour window check and the delivery record.
   */
  /**
   * The send path refuses an unsigned human message outright. Caught here so
   * the person sees what to do rather than a stack trace — the guarantee is
   * the throw, this is the manners.
   */
  let result
  try {
    result = await queueOutboundText(actorRunner(actor), {
      conversationId,
      operatorId: actor.operatorId,
      body,
      // Stable per submission so a double-click cannot queue two replies.
      idempotencyKey: `staff:${actor.membershipId}:${hash(conversationId + body)}`,
      sentByMembershipId: actor.membershipId,
    })
  } catch (error: unknown) {
    if (error instanceof NoDisplayName) {
      return {
        error: 'Your replies are signed with your name, and you have not set one yet. '
          + 'Add it on the Team page and send this again.',
      }
    }
    throw error
  }

  if (result.messageId === null && !result.duplicate) {
    return { error: 'That conversation could not be found.' }
  }

  revalidatePath(`/conversations/${conversationId}`)
  return { error: null }
}

export async function takeOver(formData: FormData): Promise<void> {
  const actor = await requireActor()
  const conversationId = String(formData.get('conversationId') ?? '')
  assertPermitted(permissions.canReply(actor), 'take over a conversation')

  await takeOverConversation(actorRunner(actor), {
    conversationId,
    operatorId: actor.operatorId,
    membershipId: actor.membershipId,
  })
  revalidatePath(`/conversations/${conversationId}`)
}

export async function handBackToAi(formData: FormData): Promise<void> {
  const actor = await requireActor()
  const conversationId = String(formData.get('conversationId') ?? '')
  assertPermitted(permissions.canReply(actor), 'return a conversation to the AI')

  await resumeAi(actorRunner(actor), {
    conversationId,
    operatorId: actor.operatorId,
    membershipId: actor.membershipId,
  })
  revalidatePath(`/conversations/${conversationId}`)
}

export async function toggleAiSending(formData: FormData): Promise<void> {
  const actor = await requireActor()
  assertPermitted(permissions.canControlAi(actor), 'change the AI switch')

  await setOperatorAiSending(actorRunner(actor), {
    operatorId: actor.operatorId,
    enabled: String(formData.get('enabled')) === 'true',
    membershipId: actor.membershipId,
  })
  revalidatePath('/')
}

export async function addInternalNote(
  _previous: { error: string | null },
  formData: FormData,
): Promise<{ error: string | null }> {
  const actor = await requireActor()
  const conversationId = String(formData.get('conversationId') ?? '')
  const body = String(formData.get('body') ?? '').trim()
  if (body === '') return { error: 'Write something first.' }

  /**
   * No role check beyond membership. Operations staff cannot reply to a
   * customer but must be able to leave a note — that is how they answer a
   * question about a vehicle without the customer hearing from them directly.
   */
  const result = await addNote(actorRunner(actor), {
    operatorId: actor.operatorId,
    conversationId,
    membershipId: actor.membershipId,
    body,
  })
  if (result.noteId === null) return { error: 'That conversation could not be found.' }

  revalidatePath(`/conversations/${conversationId}`)
  return { error: null }
}

export async function assignTo(formData: FormData): Promise<void> {
  const actor = await requireActor()
  assertPermitted(permissions.canReassign(actor), 'reassign a conversation')

  const conversationId = String(formData.get('conversationId') ?? '')
  const raw = String(formData.get('assignee') ?? '')

  await assignConversation(actorRunner(actor), {
    operatorId: actor.operatorId,
    conversationId,
    assigneeMembershipId: raw === '' ? null : raw,
    actorMembershipId: actor.membershipId,
  })
  revalidatePath(`/conversations/${conversationId}`)
}

export async function changePriority(formData: FormData): Promise<void> {
  const actor = await requireActor()
  assertPermitted(permissions.canReply(actor), 'change priority')

  const conversationId = String(formData.get('conversationId') ?? '')
  await setPriority(actorRunner(actor), {
    operatorId: actor.operatorId,
    conversationId,
    priority: String(formData.get('priority') ?? 'normal'),
    actorMembershipId: actor.membershipId,
  })
  revalidatePath(`/conversations/${conversationId}`)
}

/** Small stable hash so an idempotency key stays a sensible length. */
function hash(input: string): string {
  let h = 2166136261
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0).toString(36)
}

/**
 * Taking a handoff off the shared queue.
 *
 * The handoff id comes from the form, and that is safe for the same reason the
 * conversation id is: `acceptHandoff` scopes on the operator derived from the
 * session, so an id belonging to another operator matches nothing and reports
 * that somebody else has it rather than acting.
 *
 * Two people clicking Accept at once is the ordinary case in a shared queue,
 * not an edge case. The loser is told who took it, rather than silently
 * appearing to succeed.
 */
export async function claimHandoff(
  _previous: { error: string | null },
  formData: FormData,
): Promise<{ error: string | null }> {
  const actor = await requireActor()
  const handoffId = String(formData.get('handoffId') ?? '')

  try {
    assertPermitted(permissions.canReply(actor), 'accept a handoff')
  } catch {
    return { error: 'Your role cannot accept handoffs.' }
  }

  const result = await acceptHandoff(actorRunner(actor), {
    handoffId,
    operatorId: actor.operatorId,
    membershipId: actor.membershipId,
  })

  revalidatePath('/handoffs')
  revalidatePath('/')

  if (!result.accepted) {
    return {
      error: result.takenBy === null
        ? 'That handoff is no longer open.'
        : 'Someone else accepted this a moment ago.',
    }
  }
  return { error: null }
}

/**
 * Answering an Operations request.
 *
 * `checkedAt` comes from the form rather than from `now()`, because a person
 * may be recording something they looked at ten minutes ago and the difference
 * is what the customer is told. The validity window runs from that moment, so
 * a late-recorded answer expires earlier rather than later.
 *
 * The source is required and not defaulted. "An answer carries its source and
 * the time it was checked" — a blank source with a plausible timestamp is
 * exactly the unverifiable answer section 6 forbids.
 */
export async function answerOperations(
  _previous: { error: string | null },
  formData: FormData,
): Promise<{ error: string | null }> {
  const actor = await requireActor()
  const requestId = String(formData.get('requestId') ?? '')
  const answer = String(formData.get('answer') ?? '')
  const source = String(formData.get('source') ?? '').trim()
  const note = String(formData.get('note') ?? '').trim()
  const checkedMinutesAgo = Number(formData.get('checkedMinutesAgo') ?? 0)

  if (!['available', 'unavailable', 'pending_confirmation', 'unknown'].includes(answer)) {
    return { error: 'Choose an answer.' }
  }
  if (source === '') {
    return { error: 'Say where you checked. An answer without a source cannot be given to a customer.' }
  }

  try {
    assertPermitted(permissions.canReply(actor), 'answer an Operations request')
  } catch {
    return { error: 'Your role cannot answer Operations requests.' }
  }

  const result = await answerOperationsRequest(actorRunner(actor), {
    requestId,
    operatorId: actor.operatorId,
    membershipId: actor.membershipId,
    answer: answer as 'available' | 'unavailable' | 'pending_confirmation' | 'unknown',
    source,
    note: note === '' ? null : note,
    checkedAt: new Date(Date.now() - Math.max(0, checkedMinutesAgo) * 60_000),
  })

  if (!result.answered) return { error: 'That request was already answered or cancelled.' }

  /**
   * And tell the customer, which nothing did.
   *
   * Seven of these were raised during the pilot. Every one recorded an answer
   * on this screen and sent nothing: the customer asked whether the Ferrari
   * was free on the 26th, somebody found out, wrote it down, and the person
   * waiting on WhatsApp was never told. The queue emptied and the conversation
   * did not move, which is indistinguishable from nobody having looked.
   *
   * Optional, because an answer is worth recording even when the salesperson
   * would rather phrase it themselves in the thread — but it is right here, so
   * the ordinary case is one action rather than two screens.
   */
  const reply = String(formData.get('reply') ?? '').trim()
  if (reply !== '' && result.conversationId !== null) {
    if (actor.displayName === null) {
      return {
        error: 'The answer was recorded, but your reply needs your name on it and you have '
          + 'not set one. Add it on the Team page, then write to them from the conversation.',
      }
    }
    try {
      await queueOutboundText(actorRunner(actor), {
        conversationId: result.conversationId,
        operatorId: actor.operatorId,
        body: reply,
        idempotencyKey: `ops:${requestId}`,
        sentByMembershipId: actor.membershipId,
      })
      revalidatePath(`/conversations/${result.conversationId}`)
    } catch (error: unknown) {
      if (!(error instanceof NoDisplayName)) throw error
      return { error: 'Your name is not set, so the reply could not be sent.' }
    }
  }

  revalidatePath('/operations')
  return { error: null }
}

/**
 * Approving a draft quote, and sending it.
 *
 * The message is rendered from the stored figures, not written here and not
 * written by the model. Section 18.8: material commercial amounts come from
 * validated database fields. The agent phrased everything around this
 * conversation; the numbers are the one thing it never touched.
 *
 * Approval and sending are one action on purpose. An approved quote that
 * nobody sent is the same silence as no quote, and this project has produced
 * that shape four times already.
 */
export async function approveAndSendQuote(
  _previous: { error: string | null },
  formData: FormData,
): Promise<{ error: string | null }> {
  const actor = await requireActor()
  const quoteId = String(formData.get('quoteId') ?? '')
  const revision = Number(formData.get('revision') ?? 0)

  try {
    assertPermitted(permissions.canReply(actor), 'approve a quote')
  } catch {
    return { error: 'Your role cannot approve quotes.' }
  }

  const run = actorRunner(actor)
  const draft = (await listDraftQuotes(run, actor.operatorId)).find((q) => q.id === quoteId)
  if (draft === undefined) return { error: 'That quote is no longer a draft.' }

  /**
   * Checked before the quote is approved, not after.
   *
   * Approving and then failing to send would leave a quote marked approved
   * that the customer never received, which is the one state nobody watching
   * this screen could tell apart from a delivered one.
   */
  if (actor.displayName === null) {
    return {
      error: 'A quote you approve goes out signed with your name, and you have not set '
        + 'one yet. Add it on the Team page and approve this again.',
    }
  }

  const result = await approveQuote(run, {
    quoteId, operatorId: actor.operatorId, membershipId: actor.membershipId, revision,
  })
  if (!result.approved) {
    return {
      error: result.reason === 'expired'
        ? 'That quote has expired. Ask the agent to prepare a new one.'
        : result.reason === 'revision_moved'
          ? 'This quote changed while you were reading it. Reload and check the new figures.'
          : 'That quote could not be approved.',
    }
  }

  // Through the one path that sends, like every other outbound message.
  let queued
  try {
    queued = await queueOutboundText(run, {
      conversationId: draft.conversationId,
      operatorId: actor.operatorId,
      body: renderQuoteMessage(draft),
      idempotencyKey: `quote:${quoteId}:${revision}`,
      sentByMembershipId: actor.membershipId,
    })
  } catch (error: unknown) {
    if (error instanceof NoDisplayName) {
      return {
        error: 'A quote you approve goes out signed with your name, and you have not set '
          + 'one yet. Add it on the Team page and approve this again.',
      }
    }
    throw error
  }
  if (queued.messageId !== null) {
    await run(
      `update quotes set state = 'sent', sent_message_id = $2, updated_at = now() where id = $1`,
      [quoteId, queued.messageId],
    )
  }

  revalidatePath('/operations')
  revalidatePath(`/conversations/${draft.conversationId}`)
  return { error: null }
}

/**
 * Recording a rate.
 *
 * Amounts arrive as decimal strings because that is how a person types money,
 * and are converted to integer fils here — the one boundary where that
 * conversion happens, so nothing downstream ever sees a float.
 */
export async function saveRate(
  _previous: { error: string | null },
  formData: FormData,
): Promise<{ error: string | null }> {
  const actor = await requireActor()

  try {
    assertPermitted(permissions.canAdminister(actor), 'set a rate')
  } catch {
    return { error: 'Only an administrator can set rates.' }
  }

  const toMinor = (name: string): number | null => {
    const raw = String(formData.get(name) ?? '').trim()
    if (raw === '') return null
    const value = Number(raw)
    if (!Number.isFinite(value) || value < 0) return null
    // Rounded, not truncated: 1500.005 is a typo, and either way it must not
    // silently become a different number.
    return Math.round(value * 100)
  }

  const vehicleId = String(formData.get('vehicleId') ?? '')
  const daily = toMinor('dailyRate')
  if (daily === null || daily === 0) return { error: 'A daily rate is required.' }

  await setVehicleRate(actorRunner(actor), {
    operatorId: actor.operatorId,
    vehicleId,
    // The name on the rate is the person who entered it, from the session.
    confirmedBy: actor.email ?? actor.membershipId,
    dailyRateMinor: daily,
    weeklyRateMinor: toMinor('weeklyRate'),
    monthlyRateMinor: toMinor('monthlyRate'),
    minimumDays: Number(formData.get('minimumDays') ?? 1) || 1,
    includedKmPerDay: Number(formData.get('includedKm') ?? 0) || null,
    extraKmRateMinor: toMinor('extraKmRate'),
    depositMinor: toMinor('deposit'),
    deliveryFeeMinor: toMinor('deliveryFee'),
  })

  revalidatePath('/rates')
  return { error: null }
}


export type SeasonState = { error: string | null; saved?: boolean }

/**
 * A season: December dearer, the summer cheaper, for one car or every car.
 *
 * The percentage is typed as the operator says it — "20" for twenty percent
 * more, "-15" for fifteen off — and the name they give it is what the customer
 * reads on the quote beside the amount.
 */
export async function saveSeason(
  _previous: SeasonState,
  formData: FormData,
): Promise<SeasonState> {
  const actor = await requireActor()
  try {
    assertPermitted(permissions.canAdminister(actor), 'set a season')
  } catch {
    return { error: 'Only an administrator can set seasons.' }
  }

  const vehicleId = String(formData.get('vehicleId') ?? '')
  const raw = String(formData.get('percent') ?? '').trim().replace(/%$/, '')
  const result = await addRateSeason(actorRunner(actor), {
    operatorId: actor.operatorId,
    vehicleId: vehicleId === '' ? null : vehicleId,
    name: String(formData.get('name') ?? ''),
    startDate: String(formData.get('startDate') ?? ''),
    endDate: String(formData.get('endDate') ?? ''),
    percent: raw === '' ? Number.NaN : Number(raw),
    createdBy: actor.email ?? actor.membershipId,
  })
  if (!result.ok) {
    const say = {
      name: 'Give the season a short name, like "Peak season".',
      dates: 'The last day must be on or after the first.',
      percent: 'The change is a whole percent between -90 and 300, and not 0 — "20" for 20% more, "-15" for 15% off.',
      vehicle: 'That car is not one of yours.',
    } as const
    return { error: say[result.problem] }
  }

  revalidatePath('/rates')
  return { error: null, saved: true }
}

/** Ending a season. The quotes priced in it keep their figures. */
export async function endSeason(formData: FormData): Promise<void> {
  const actor = await requireActor()
  assertPermitted(permissions.canAdminister(actor), 'remove a season')
  await removeRateSeason(actorRunner(actor), {
    operatorId: actor.operatorId,
    seasonId: String(formData.get('seasonId') ?? ''),
    removedBy: actor.email ?? actor.membershipId,
  })
  revalidatePath('/rates')
}


export type PhotoState = { error: string | null }

/**
 * Does this link actually serve a picture?
 *
 * Until now the answer was found out by a customer. The shape of the URL was
 * checked here and the fetch was left to WhatsApp, so a photograph that had
 * moved, or sat behind hotlink protection, or was a webp, became a message that
 * silently arrived with nothing in it — and nothing in this system knew.
 *
 * Deliberately generous about failure: a host that refuses HEAD is common
 * enough that treating it as a broken link would block real photographs, so it
 * falls back to asking for the first byte. A network failure here is reported
 * as a network failure rather than as a bad link, because the difference
 * matters to whoever has to fix it.
 */
async function servesAPicture(url: string): Promise<string | null> {
  const attempt = async (init: RequestInit): Promise<Response> =>
    await fetch(url, { ...init, redirect: 'follow', signal: AbortSignal.timeout(8000) })

  let response: Response
  try {
    response = await attempt({ method: 'HEAD' })
    // Plenty of CDNs answer HEAD with a refusal and a GET with the file.
    if (response.status === 403 || response.status === 405 || response.status === 501) {
      response = await attempt({ method: 'GET', headers: { Range: 'bytes=0-0' } })
    }
  } catch {
    return 'could not be reached. If the link is right, try saving again.'
  }

  return complaintAboutImage({
    status: response.status,
    contentType: response.headers.get('content-type'),
    contentLength: response.headers.get('content-length'),
    contentRange: response.headers.get('content-range'),
  })
}

/** The photo links as typed, one per line, blanks dropped. */
function photoLinks(formData: FormData): string[] {
  return String(formData.get('photoUrls') ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
}

/**
 * What is wrong with a set of photo links, as a sentence, or null.
 *
 * https only, and checked rather than trusted: WhatsApp fetches the image
 * itself and will not follow an http link, so an http URL is a message that
 * silently arrives with no picture. A malformed one is refused for the same
 * reason — the failure would otherwise be invisible until a customer saw
 * nothing.
 *
 * Fetched together rather than one at a time — six links checked in sequence
 * is six timeouts in the worst case, and a save that takes a minute is a save
 * somebody stops making. The first complaint is the one reported, so the
 * message names one link to fix rather than listing all of them.
 */
async function problemWithPhotoLinks(urls: string[]): Promise<string | null> {
  for (const url of urls) {
    if (!url.startsWith('https://')) {
      return `"${url.slice(0, 40)}" is not an https link. WhatsApp will not fetch it.`
    }
    try {
      new URL(url)
    } catch {
      return `"${url.slice(0, 40)}" is not a valid address.`
    }
  }

  const verdicts = await Promise.all(urls.map(servesAPicture))
  const broken = verdicts.findIndex((v) => v !== null)
  if (broken !== -1) {
    const url = urls[broken]!
    const shown = url.length > 52 ? `${url.slice(0, 49)}…` : url
    return `"${shown}" ${verdicts[broken]!}`
  }
  return null
}

/**
 * Photographs of a car, as public links.
 *
 * Checked by problemWithPhotoLinks before anything is written.
 */
export async function savePhotos(_previous: PhotoState, formData: FormData): Promise<PhotoState> {
  const actor = await requireActor()
  assertPermitted(permissions.canAdminister(actor), 'change vehicle photographs')

  const vehicleId = String(formData.get('vehicleId') ?? '')
  const urls = photoLinks(formData)
  const problem = await problemWithPhotoLinks(urls)
  if (problem !== null) return { error: problem }

  /**
   * The collage URL is written here rather than worked out at send time, so
   * the worker needs no idea where the inbox is published. Built from the host
   * serving this request, which is the only place that knows it without
   * configuration.
   *
   * Two photographs or more, because a collage of one is a photograph.
   */
  const host = (await headers()).get('host')
  const collageUrl = urls.length >= 2 && host !== null
    ? `https://${host}/api/fleet-photo/${vehicleId}`
    : null

  await actorRunner(actor)(
    `update vehicles set photo_urls = $3::jsonb, collage_url = $4, updated_at = now()
     where id = $1 and operator_id = $2`,
    [
      vehicleId,
      actor.operatorId,
      urls.length === 0 ? null : JSON.stringify(urls),
      collageUrl,
    ],
  )

  revalidatePath('/rates')
  return { error: null }
}


/**
 * The error, and what was typed. React resets a form once its action returns,
 * so a refusal that did not hand the values back would make the person type
 * the whole car again to fix one field.
 */
export type AddCarState = { error: string | null; values?: Record<string, string> }

/** What each refusal means to the person holding the form. */
const ADD_CAR_PROBLEMS: Record<AddVehicleProblem, string> = {
  make: 'Enter the make, e.g. Lamborghini.',
  model: 'Enter the model, e.g. Urus.',
  year: 'Enter the year as four digits, e.g. 2024.',
  colour: 'Enter the colour.',
  category: 'Choose a category.',
  plate: 'Enter the plate as it is written on the car.',
  chassis: 'Enter the chassis number (VIN).',
  seats: 'Seats should be a whole number, or left blank.',
  rate: 'A daily rate is required. The agent cannot quote a car without one.',
  deposit: 'The deposit should be an amount, or left blank.',
  plate_taken: 'A car with that plate is already in your fleet.',
  chassis_taken: 'A car with that chassis number is already in your fleet.',
}

/**
 * Adding a car, priced, with its photographs, in one save.
 *
 * An administrator's act, like setting a rate: the car arrives confirmed and
 * the agent can offer it the moment this returns, so whoever presses Save is
 * the person standing behind it. Amounts convert to fils here, the same single
 * boundary saveRate uses.
 */
export async function addCar(_previous: AddCarState, formData: FormData): Promise<AddCarState> {
  const actor = await requireActor()
  try {
    assertPermitted(permissions.canAdminister(actor), 'add a car')
  } catch {
    return { error: 'Only an administrator can add cars.' }
  }

  const text = (name: string) => String(formData.get(name) ?? '').trim()
  const whole = (name: string): number | null => {
    const raw = text(name)
    return raw === '' ? null : Number(raw)
  }
  const toMinor = (name: string): number | null => {
    const raw = text(name)
    if (raw === '') return null
    const value = Number(raw)
    return Number.isFinite(value) ? Math.round(value * 100) : NaN
  }

  const values: Record<string, string> = {}
  for (const [key, value] of formData.entries()) {
    if (typeof value === 'string' && !key.startsWith('$')) values[key] = value
  }

  const urls = photoLinks(formData)
  const photoProblem = await problemWithPhotoLinks(urls)
  if (photoProblem !== null) return { error: photoProblem, values }

  // Chosen here because the collage link names the car, and is built from the
  // host serving this request — see savePhotos.
  const vehicleId = crypto.randomUUID()
  const host = (await headers()).get('host')

  const result = await addVehicle(actorTransactor(actor), {
    vehicleId,
    operatorId: actor.operatorId,
    membershipId: actor.membershipId,
    confirmedBy: actor.email ?? actor.membershipId,
    make: text('make'),
    model: text('model'),
    variant: text('variant'),
    year: whole('year') ?? NaN,
    colour: text('colour'),
    category: text('category'),
    plate: text('plate'),
    chassisNumber: text('chassisNumber'),
    seats: whole('seats'),
    dailyRateMinor: toMinor('dailyRate') ?? 0,
    depositMinor: toMinor('deposit'),
    photoUrls: urls,
    collageUrl: urls.length >= 2 && host !== null ? `https://${host}/api/fleet-photo/${vehicleId}` : null,
  })
  if (!result.ok) return { error: ADD_CAR_PROBLEMS[result.problem], values }

  revalidatePath('/rates')
  revalidatePath('/setup')
  redirect(`/rates?added=${result.vehicleId}`)
}

export type HighlightState = { error: string | null }

/**
 * A few words the operator wants beside a car.
 *
 * An administrator's to set, like the rate: it is a claim customers read in
 * the operator's voice, not a preference about how the screen looks.
 */
export async function saveHighlight(
  _previous: HighlightState,
  formData: FormData,
): Promise<HighlightState> {
  const actor = await requireActor()
  assertPermitted(permissions.canAdminister(actor), 'set what is said about a car')

  const vehicleId = String(formData.get('vehicleId') ?? '')
  const highlight = String(formData.get('highlight') ?? '')

  const result = await setVehicleHighlight(actorRunner(actor), {
    operatorId: actor.operatorId,
    vehicleId,
    highlight,
    actorMembershipId: actor.membershipId,
  })

  if (!result.changed) {
    return { error: 'That car is not one of yours, or is no longer active.' }
  }

  revalidatePath('/rates')
  return { error: null }
}

/**
 * Taking something off the price, and sending the new one.
 *
 * On the same screen as Approve and send, because a salesperson looking at a
 * quote either sends it or wants it to be a different number, and making the
 * second of those a different page is how it ends up typed into a message
 * instead — which is what the record could not survive once bookings started
 * confirming against a quote id.
 *
 * It sends in the same act. A discounted quote nobody sent is a customer still
 * waiting on the price they asked about.
 */
export async function discountAndSendQuote(
  _previous: { error: string | null },
  formData: FormData,
): Promise<{ error: string | null }> {
  const actor = await requireActor()

  try {
    assertPermitted(permissions.canReply(actor), 'discount a quote')
  } catch {
    return { error: 'Your role cannot change quotes.' }
  }
  if (actor.displayName === null) {
    return {
      error: 'The new price goes out signed with your name, and you have not set one yet. '
        + 'Add it on the Team page and try again.',
    }
  }

  const quoteId = String(formData.get('quoteId') ?? '')
  const revision = Number(formData.get('revision') ?? 0)
  const reason = String(formData.get('reason') ?? '').trim()

  /** Whole currency on the form, minor units in the record, like every amount. */
  const major = Number(String(formData.get('discount') ?? '').trim())
  if (!Number.isFinite(major) || major <= 0) {
    return { error: 'Enter how much to take off, as a number greater than zero.' }
  }
  if (reason === '') {
    return { error: 'Say why. It is not sent to the customer — it is for your own reckoning.' }
  }

  const run = actorRunner(actor)
  const result = await discountQuote(actorTransactor(actor), {
    operatorId: actor.operatorId,
    quoteId,
    membershipId: actor.membershipId,
    revision,
    discountMinor: Math.round(major * 100),
    reason,
  })

  if (!result.ok) {
    return {
      error: result.reason === 'revision_moved'
        ? 'This quote changed while you were reading it. Reload and check the new figures.'
        : result.reason === 'too_large'
          ? 'That is more than the total. A discount takes something off a price; it cannot make one.'
          : result.reason === 'not_a_draft'
            ? 'That quote has already been sent. Ask the agent to prepare a new one.'
            : 'That quote could not be found.',
    }
  }

  const [draft] = await listDraftQuotes(run, actor.operatorId)
    .then((all) => all.filter((q) => q.id === result.quoteId))
  const message = draft === undefined ? null : renderQuoteMessage(draft)

  if (message !== null) {
    const queued = await queueOutboundText(run, {
      conversationId: draft!.conversationId,
      operatorId: actor.operatorId,
      body: message,
      idempotencyKey: `quote:${result.quoteId}:${result.revision}`,
      sentByMembershipId: actor.membershipId,
    })
    if (queued.messageId !== null) {
      await run(
        `update quotes set state = 'sent', sent_message_id = $2, updated_at = now() where id = $1`,
        [result.quoteId, queued.messageId],
      )
    }
    revalidatePath(`/conversations/${draft!.conversationId}`)
  }

  revalidatePath('/operations')
  return { error: null }
}

/**
 * Marking a lead won or lost, which nothing in the product could do.
 *
 * `closeLead` has existed since the reports did, is covered by its own tests,
 * and was called from no screen — so `sales_stage` never reached won or lost.
 * That made the conversion rate on the reports page structurally zero, left
 * the inbox's stage filter with nothing to filter, and kept `findDueFollowUps`
 * chasing customers whose lead had been settled weeks earlier.
 *
 * A confirmed booking now closes its own lead. This is for everything that
 * ends some other way: they went elsewhere, they were not eligible, they
 * stopped replying.
 */
export async function closeThisLead(
  _previous: { error: string | null },
  formData: FormData,
): Promise<{ error: string | null }> {
  const actor = await requireActor()

  try {
    assertPermitted(permissions.canReply(actor), 'close a lead')
  } catch {
    return { error: 'Your role cannot close leads.' }
  }

  const conversationId = String(formData.get('conversationId') ?? '')
  const outcome = String(formData.get('outcome') ?? '')
  if (outcome !== 'won' && outcome !== 'lost') return { error: 'Choose won or lost.' }

  const reason = String(formData.get('reason') ?? '').trim()
  if (outcome === 'lost' && reason === '') {
    return {
      error: 'Say why it was lost. "Why did we lose it" is the question the reports exist to '
        + 'answer, and an uncategorised loss answers nothing.',
    }
  }

  const result = await closeLead(actorRunner(actor), {
    operatorId: actor.operatorId,
    conversationId,
    membershipId: actor.membershipId,
    outcome,
    reason: outcome === 'lost' ? (reason as never) : null,
    note: String(formData.get('note') ?? '').trim() || null,
  })

  if (!result.closed) {
    return { error: 'That lead is already closed. Reload to see where it stands.' }
  }

  revalidatePath(`/conversations/${conversationId}`)
  revalidatePath('/reports')
  return { error: null }
}

/**
 * Turning a draft quote down.
 *
 * The screen offered Approve and send and nothing else, so a figure somebody
 * did not want stayed in the queue for good — and the only honest reading of
 * that screen was that approving was the sole option.
 *
 * Nothing is sent. The customer never saw this price; there is nothing to
 * retract, and telling them a number was considered and dropped is worse than
 * saying nothing.
 */
export async function rejectThisQuote(
  _previous: { error: string | null },
  formData: FormData,
): Promise<{ error: string | null }> {
  const actor = await requireActor()

  try {
    assertPermitted(permissions.canReply(actor), 'reject a quote')
  } catch {
    return { error: 'Your role cannot change quotes.' }
  }

  const reason = String(formData.get('reason') ?? '').trim()
  if (reason === '') return { error: 'Say why, so the next person reading this knows.' }

  const result = await rejectQuote(actorRunner(actor), {
    operatorId: actor.operatorId,
    quoteId: String(formData.get('quoteId') ?? ''),
    membershipId: actor.membershipId,
    revision: Number(formData.get('revision') ?? 0),
    reason,
  })

  if (!result.rejected) {
    return { error: 'That quote changed while you were reading it. Reload and check.' }
  }

  revalidatePath('/operations')
  return { error: null }
}

/** Dropping an availability request nobody needs to answer any more. */
export async function dismissRequest(formData: FormData): Promise<void> {
  const actor = await requireActor()
  assertPermitted(permissions.canReply(actor), 'dismiss an Operations request')

  await dismissOperationsRequest(actorRunner(actor), {
    operatorId: actor.operatorId,
    requestId: String(formData.get('requestId') ?? ''),
    membershipId: actor.membershipId,
    reason: String(formData.get('reason') ?? '').trim() || 'No longer needed.',
  })
  revalidatePath('/operations')
}

'use server'

import { headers } from 'next/headers'
import {
  acceptHandoff,
  addNote,
  answerOperationsRequest,
  approveQuote,
  listDraftQuotes,
  renderQuoteMessage,
  setVehicleRate,
  setVehicleHighlight,
  assignConversation,
  queueOutboundText,
  resumeAi,
  setOperatorAiSending,
  setPriority,
  takeOverConversation,
} from '@vyra/db'
import { complaintAboutImage } from '@vyra/contracts'
import { revalidatePath } from 'next/cache'
import { assertPermitted, permissions, requireActor } from '@/lib/auth'
import { actorRunner } from '@/lib/db'

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
  const result = await queueOutboundText(actorRunner(actor), {
    conversationId,
    operatorId: actor.operatorId,
    body,
    // Stable per submission so a double-click cannot queue two replies.
    idempotencyKey: `staff:${actor.membershipId}:${hash(conversationId + body)}`,
    sentByMembershipId: actor.membershipId,
  })

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

  revalidatePath('/operations')
  if (!result.answered) return { error: 'That request was already answered or cancelled.' }
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
  const queued = await queueOutboundText(run, {
    conversationId: draft.conversationId,
    operatorId: actor.operatorId,
    body: renderQuoteMessage(draft),
    idempotencyKey: `quote:${quoteId}:${revision}`,
    sentByMembershipId: actor.membershipId,
  })
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

/**
 * Photographs of a car, as public links.
 *
 * https only, and checked here rather than trusted: WhatsApp fetches the image
 * itself and will not follow an http link, so an http URL is a message that
 * silently arrives with no picture. A malformed one is refused for the same
 * reason — the failure would otherwise be invisible until a customer saw
 * nothing.
 */
export async function savePhotos(_previous: PhotoState, formData: FormData): Promise<PhotoState> {
  const actor = await requireActor()
  assertPermitted(permissions.canAdminister(actor), 'change vehicle photographs')

  const vehicleId = String(formData.get('vehicleId') ?? '')
  const urls = String(formData.get('photoUrls') ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')

  for (const url of urls) {
    if (!url.startsWith('https://')) {
      return { error: `"${url.slice(0, 40)}" is not an https link. WhatsApp will not fetch it.` }
    }
    try {
      new URL(url)
    } catch {
      return { error: `"${url.slice(0, 40)}" is not a valid address.` }
    }
  }

  /**
   * Fetched together rather than one at a time — six links checked in sequence
   * is six timeouts in the worst case, and a save that takes a minute is a save
   * somebody stops making. The first complaint is the one reported, so the
   * message names one link to fix rather than listing all of them.
   */
  const verdicts = await Promise.all(urls.map(servesAPicture))
  const broken = verdicts.findIndex((v) => v !== null)
  if (broken !== -1) {
    const url = urls[broken]!
    const shown = url.length > 52 ? `${url.slice(0, 49)}…` : url
    return { error: `"${shown}" ${verdicts[broken]!}` }
  }

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

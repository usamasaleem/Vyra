'use server'

import { revalidatePath } from 'next/cache'
import { cancelBooking, decideBooking, NoDisplayName, queueOutboundText } from '@vyra/db'
import { assertPermitted, permissions, requireActor } from '@/lib/auth'
import { actorRunner, actorTransactor } from '@/lib/db'

export type DecisionState = { error: string | null; answered?: string }

/**
 * Answering somebody who said yes.
 *
 * The decision and the message are one action on purpose. Recorded without
 * telling them is the state this whole screen exists to end — a customer who
 * committed, waiting, while a row somewhere says confirmed. Sent without
 * recording is worse: a confirmation nobody can find.
 *
 * The message is whatever the person wrote. It is drafted for them because a
 * blank box at the moment of a sale is how four automated messages stayed
 * unwritten for a whole pilot, and it is theirs to change because nothing goes
 * to a customer in words nobody stood behind. It goes through the one path
 * that sends, signed with their name, like every other message from a person.
 */
export async function answerBooking(
  _previous: DecisionState,
  formData: FormData,
): Promise<DecisionState> {
  const actor = await requireActor()

  try {
    assertPermitted(permissions.canReply(actor), 'confirm a booking')
  } catch {
    return { error: 'Your role cannot confirm bookings.' }
  }

  const bookingId = String(formData.get('bookingId') ?? '')
  const decision = String(formData.get('decision') ?? '')
  const message = String(formData.get('message') ?? '').trim()

  if (decision !== 'confirmed' && decision !== 'declined') {
    return { error: 'Choose whether this is confirmed or not.' }
  }
  if (message === '') {
    return { error: 'Write what the customer should be told.' }
  }
  if (actor.displayName === null) {
    return {
      error: 'This message goes out signed with your name, and you have not set one yet. '
        + 'Add it on the Team page and answer this again.',
    }
  }

  const decided = await decideBooking(actorTransactor(actor), {
    operatorId: actor.operatorId,
    bookingId,
    membershipId: actor.membershipId,
    decision,
    note: String(formData.get('note') ?? '').trim() || null,
  })

  if (decided.conflict !== undefined) {
    const c = decided.conflict
    return {
      error: `Not confirmed — the ${c.vehicle} is already held from ${c.startDate} to `
        + `${c.endDate} (${c.reason}), which overlaps these dates. Nothing was sent. `
        + 'Check the diary before you answer them.',
    }
  }

  if (!decided.decided || decided.conversationId === null) {
    return {
      error: 'Somebody else answered this one first. Reload to see what they said.',
    }
  }

  try {
    await queueOutboundText(actorRunner(actor), {
      conversationId: decided.conversationId,
      operatorId: actor.operatorId,
      body: message,
      // Stable per booking and decision, so a double-click sends once.
      idempotencyKey: `booking:${bookingId}:${decision}`,
      sentByMembershipId: actor.membershipId,
    })
  } catch (error: unknown) {
    if (error instanceof NoDisplayName) {
      return { error: 'Your name is not set, so the message could not be sent.' }
    }
    throw error
  }

  revalidatePath('/bookings')
  revalidatePath(`/conversations/${decided.conversationId}`)
  return { error: null, answered: bookingId }
}

/**
 * Letting a confirmed rental go.
 *
 * The car comes back on the same action, because a cancellation that releases
 * nothing leaves a vehicle nobody can sell and nobody can explain — quieter
 * than a double booking and longer-lived.
 *
 * The customer is told by whoever cancels it, in their own words, like every
 * other message from a person. There is no wording for this that we could
 * write for them: the reasons range from a car off the road to a customer who
 * rang up and changed their mind.
 */
export async function cancelConfirmedBooking(
  _previous: DecisionState,
  formData: FormData,
): Promise<DecisionState> {
  const actor = await requireActor()

  try {
    assertPermitted(permissions.canReply(actor), 'cancel a booking')
  } catch {
    return { error: 'Your role cannot cancel bookings.' }
  }

  const bookingId = String(formData.get('bookingId') ?? '')
  const message = String(formData.get('message') ?? '').trim()
  if (message === '') return { error: 'Write what the customer should be told.' }
  if (actor.displayName === null) {
    return {
      error: 'This message goes out signed with your name, and you have not set one yet. '
        + 'Add it on the Team page and try again.',
    }
  }

  const cancelled = await cancelBooking(actorTransactor(actor), {
    operatorId: actor.operatorId,
    bookingId,
    membershipId: actor.membershipId,
    note: String(formData.get('note') ?? '').trim() || null,
  })

  if (!cancelled.cancelled || cancelled.conversationId === null) {
    return { error: 'That booking is not confirmed any more. Reload to see where it stands.' }
  }

  try {
    await queueOutboundText(actorRunner(actor), {
      conversationId: cancelled.conversationId,
      operatorId: actor.operatorId,
      body: message,
      idempotencyKey: `booking:${bookingId}:cancelled`,
      sentByMembershipId: actor.membershipId,
    })
  } catch (error: unknown) {
    if (error instanceof NoDisplayName) {
      return { error: 'Your name is not set, so the message could not be sent.' }
    }
    throw error
  }

  revalidatePath('/bookings')
  revalidatePath(`/conversations/${cancelled.conversationId}`)
  return { error: null, answered: bookingId }
}

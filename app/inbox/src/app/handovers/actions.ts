'use server'

import { revalidatePath } from 'next/cache'
import { getApprovedAnswer, markReturned, queueOutboundText } from '@vyra/db'
import { assertPermitted, permissions, requireActor } from '@/lib/auth'
import { actorRunner } from '@/lib/db'

export type ReturnState = { error: string | null; notice?: string }

const WINDOW_MS = 24 * 60 * 60 * 1000

/**
 * The car is back.
 *
 * Recorded with the name of whoever saw it, and followed by the operator's
 * thank-you when they have written one and WhatsApp still allows a free
 * message. When it cannot go, the person is told why on the spot rather than
 * finding out from a customer who never heard anything.
 */
export async function markCarReturned(
  _previous: ReturnState,
  formData: FormData,
): Promise<ReturnState> {
  const actor = await requireActor()
  try {
    assertPermitted(permissions.canReply(actor), 'mark a car returned')
  } catch {
    return { error: 'Your role cannot mark a car returned.' }
  }

  const bookingId = String(formData.get('bookingId') ?? '')
  const run = actorRunner(actor)
  const done = await markReturned(run, {
    operatorId: actor.operatorId, bookingId, membershipId: actor.membershipId,
  })
  if (!done.returned || done.conversationId === null) {
    return { error: 'That one is already marked returned, or is not a confirmed booking. Reload.' }
  }

  revalidatePath('/handovers')
  revalidatePath('/bookings')

  const thanks = await getApprovedAnswer(run, actor.operatorId, 'thank-you')
  if (thanks === null) {
    return {
      error: null,
      notice: 'Marked returned. No thank-you went, because none is written under Messages.',
    }
  }
  const [conversation] = await run(
    `select last_customer_message_at from conversations where id = $1 and operator_id = $2`,
    [done.conversationId, actor.operatorId],
  )
  const last = conversation?.['last_customer_message_at']
  if (last == null || Date.now() - new Date(last as string).getTime() >= WINDOW_MS) {
    return {
      error: null,
      notice: 'Marked returned. The thank-you did not go: they last wrote more than 24 hours ago, '
        + 'and WhatsApp only allows an approved template after that.',
    }
  }

  await queueOutboundText(run, {
    conversationId: done.conversationId,
    operatorId: actor.operatorId,
    body: thanks.answer,
    idempotencyKey: `thank-you:${bookingId}`,
  })
  revalidatePath(`/conversations/${done.conversationId}`)
  return { error: null, notice: 'Marked returned, and the thank-you is on its way.' }
}

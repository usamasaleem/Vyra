'use server'

import { revalidatePath } from 'next/cache'
import { dropFollowUp, resolveHandoff, resumeAi } from '@vyra/db'
import { assertPermitted, permissions, requireActor } from '@/lib/auth'
import { actorRunner } from '@/lib/db'

/**
 * Closing a handoff, which nothing could do.
 *
 * `resolveHandoff` has existed since the queue did, is covered by its own
 * tests, and was called from no screen in the product — so a handoff could be
 * accepted and never finished. Six of them sat open for days and had to be
 * closed by hand in the database, which is the clearest possible statement
 * that the button was missing.
 *
 * Resolving hands the conversation back to the agent. A handoff is the agent
 * standing aside; finishing one and leaving it standing aside is how a
 * customer ends up talking to nobody, which is the failure the waiting count
 * was added to catch.
 */
export async function finishHandoff(formData: FormData): Promise<void> {
  const actor = await requireActor()
  assertPermitted(permissions.canReply(actor), 'close a handoff')

  const conversationId = String(formData.get('conversationId') ?? '')
  const resolution = String(formData.get('resolution') ?? '').trim()

  const run = actorRunner(actor)
  await resolveHandoff(run, {
    conversationId,
    operatorId: actor.operatorId,
    resolution: resolution === '' ? 'Handled.' : resolution,
  })
  await resumeAi(run, {
    conversationId, operatorId: actor.operatorId, membershipId: actor.membershipId,
  }).catch(() => undefined)

  revalidatePath('/handoffs')
  revalidatePath(`/conversations/${conversationId}`)
}

/** Letting go of a chase nobody is going to send. */
export async function dismissFollowUp(formData: FormData): Promise<void> {
  const actor = await requireActor()
  assertPermitted(permissions.canReply(actor), 'drop a follow-up')

  await dropFollowUp(actorRunner(actor), {
    followUpId: String(formData.get('followUpId') ?? ''),
    operatorId: actor.operatorId,
    reason: 'dropped by a person',
  })
  revalidatePath('/handoffs')
}

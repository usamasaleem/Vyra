'use server'

import { revalidatePath } from 'next/cache'
import { removePushSubscription, requestTestAlert, savePushSubscription } from '@vyra/db'
import { requireActor } from '@/lib/auth'
import { actorRunner } from '@/lib/db'

/**
 * Anybody signed in may be told about their own customers. Nothing here
 * changes what anyone else receives.
 */
export async function saveAlertDevice(input: {
  endpoint: string
  p256dh: string
  auth: string
  userAgent: string | null
}): Promise<void> {
  const actor = await requireActor()
  if (!/^https:\/\//.test(input.endpoint) || input.p256dh === '' || input.auth === '') {
    throw new Error('That is not a push subscription.')
  }
  await savePushSubscription(actorRunner(actor), {
    operatorId: actor.operatorId,
    membershipId: actor.membershipId,
    endpoint: input.endpoint,
    p256dh: input.p256dh,
    auth: input.auth,
    userAgent: input.userAgent?.slice(0, 300) ?? null,
  })
  revalidatePath('/alerts')
}

export async function removeAlertDevice(endpoint: string): Promise<void> {
  const actor = await requireActor()
  await removePushSubscription(actorRunner(actor), { operatorId: actor.operatorId, endpoint })
  revalidatePath('/alerts')
}

export async function sendTestAlert(): Promise<void> {
  const actor = await requireActor()
  await requestTestAlert(actorRunner(actor), { operatorId: actor.operatorId, membershipId: actor.membershipId })
}

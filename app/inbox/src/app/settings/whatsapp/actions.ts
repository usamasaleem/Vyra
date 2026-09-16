'use server'

import { revalidatePath } from 'next/cache'
import { MissingSecretKeyError, sealSecret, secretHint } from '@vyra/contracts/secrets'
import { connectWhatsAppNumber, disconnectWhatsAppNumber } from '@vyra/db'
import { assertPermitted, permissions, requireActor } from '@/lib/auth'
import { actorRunner } from '@/lib/db'
import { serverEnv } from '@/lib/env'

export type ConnectState = { error: string | null; connected: boolean }

/**
 * Connecting an operator's own WhatsApp number.
 *
 * Meta's embedded signup would do this without anybody reading an id off a
 * screen, and it needs Tech Provider status, which needs business verification
 * this project has not started. Until then the operator pastes what Meta shows
 * them, which is what every WhatsApp tool did before embedded signup existed.
 *
 * The token is sealed here and the plaintext goes no further: not into the
 * query layer, not into the audit trail, not into a log line. What is recorded
 * is its last four characters, which is enough to tell two tokens apart on a
 * screen and useless to anybody who reads it.
 */
export async function connectNumber(
  _previous: ConnectState,
  formData: FormData,
): Promise<ConnectState> {
  const actor = await requireActor()
  assertPermitted(permissions.canAdminister(actor), 'connect a WhatsApp number')

  const phoneNumberId = String(formData.get('phoneNumberId') ?? '').trim()
  const wabaId = String(formData.get('wabaId') ?? '').trim()
  const displayPhoneNumber = String(formData.get('displayPhoneNumber') ?? '').trim()
  const token = String(formData.get('accessToken') ?? '').trim()

  if (!/^\d{5,}$/.test(phoneNumberId)) {
    return { error: 'The phone number id is the long number Meta shows, digits only.', connected: false }
  }
  if (!/^\d{5,}$/.test(wabaId)) {
    return { error: 'The WhatsApp Business Account id is also digits only.', connected: false }
  }
  if (token === '') {
    return { error: 'Paste the access token for this number.', connected: false }
  }

  let sealed: string
  try {
    sealed = sealSecret(token, serverEnv().WHATSAPP_TOKEN_KEY)
  } catch (error) {
    if (error instanceof MissingSecretKeyError) {
      /**
       * Refusing rather than storing it in the clear. The operator cannot fix
       * this and should not be told to try — it is a deployment variable, and
       * saying so is more use than "something went wrong".
       */
      return {
        error: 'This deployment cannot store tokens yet — WHATSAPP_TOKEN_KEY is not configured. '
          + 'Tell whoever runs it.',
        connected: false,
      }
    }
    throw error
  }

  const result = await connectWhatsAppNumber(actorRunner(actor), {
    operatorId: actor.operatorId,
    phoneNumberId,
    wabaId,
    displayPhoneNumber: displayPhoneNumber === '' ? null : displayPhoneNumber,
    accessTokenCipher: sealed,
    tokenHint: secretHint(token),
    connectedByMembershipId: actor.membershipId,
  })

  if (!result.connected) {
    return {
      error: 'That number is already connected to another operator. A WhatsApp number belongs to '
        + 'one company here.',
      connected: false,
    }
  }

  revalidatePath('/settings/whatsapp')
  revalidatePath('/setup')
  return { error: null, connected: true }
}

export async function disconnectNumber(formData: FormData): Promise<void> {
  const actor = await requireActor()
  assertPermitted(permissions.canAdminister(actor), 'disconnect a WhatsApp number')

  await disconnectWhatsAppNumber(actorRunner(actor), {
    operatorId: actor.operatorId,
    accountId: String(formData.get('accountId') ?? ''),
    actorMembershipId: actor.membershipId,
  })
  revalidatePath('/settings/whatsapp')
  revalidatePath('/setup')
}

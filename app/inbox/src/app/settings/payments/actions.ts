'use server'

import { headers } from 'next/headers'
import { revalidatePath } from 'next/cache'
import { MissingSecretKeyError, openSecret, sealSecret, secretHint } from '@vyra/contracts/secrets'
import { createStripeWebhook, deleteStripeWebhook, StripeError, stripeAccount } from '@vyra/contracts/stripe'
import { paymentAccountFor, removePaymentAccount, savePaymentAccount } from '@vyra/db'
import { assertPermitted, permissions, requireActor } from '@/lib/auth'
import { actorRunner } from '@/lib/db'
import { serverEnv } from '@/lib/env'

export type ConnectStripeState = { error: string | null; connected: boolean }

/**
 * Connecting the operator's own Stripe account.
 *
 * The key is checked against Stripe before anything is stored, the endpoint
 * that confirms payments is registered on their account for them, and both
 * secrets are sealed here — the plaintext goes nowhere else.
 */
export async function connectStripe(_previous: ConnectStripeState, formData: FormData): Promise<ConnectStripeState> {
  const actor = await requireActor()
  assertPermitted(permissions.canAdminister(actor), 'connect Stripe')
  const key = String(formData.get('secretKey') ?? '').trim()
  if (!/^(sk|rk)_(test|live)_[A-Za-z0-9]{10,}$/.test(key)) {
    return { error: 'That does not look like a Stripe secret key — it starts sk_test_, sk_live_, rk_test_ or rk_live_.', connected: false }
  }

  let account: { id: string; livemode: boolean }
  try {
    account = await stripeAccount(key)
  } catch (error) {
    return { error: error instanceof StripeError ? `Stripe refused the key: ${error.message}` : 'Could not reach Stripe. Try again.', connected: false }
  }

  const keyMaterial = serverEnv().WHATSAPP_TOKEN_KEY
  const run = actorRunner(actor)
  const host = (await headers()).get('host') ?? 'vyra-inbox.netlify.app'
  try {
    const previous = await paymentAccountFor(run, actor.operatorId)
    const previousKey = previous === null ? null : openSecret(previous.secretKeyCipher, keyMaterial)
    if (previous !== null && previousKey !== null) await deleteStripeWebhook(previousKey, previous.webhookEndpointId)

    const webhook = await createStripeWebhook(key, `https://${host}/api/webhooks/stripe?operator=${actor.operatorId}`)
    await savePaymentAccount(run, {
      operatorId: actor.operatorId,
      provider: 'stripe',
      secretKeyCipher: sealSecret(key, keyMaterial),
      secretKeyHint: secretHint(key),
      webhookSecretCipher: sealSecret(webhook.secret, keyMaterial),
      webhookEndpointId: webhook.id,
      accountId: account.id,
      livemode: account.livemode,
      membershipId: actor.membershipId,
    })
  } catch (error) {
    if (error instanceof MissingSecretKeyError) {
      return {
        error: 'This deployment cannot store keys yet — WHATSAPP_TOKEN_KEY is not configured on the inbox and the worker. Tell whoever runs it.',
        connected: false,
      }
    }
    if (error instanceof StripeError) return { error: `Stripe refused: ${error.message}`, connected: false }
    throw error
  }
  revalidatePath('/settings/payments')
  revalidatePath('/autonomy')
  return { error: null, connected: true }
}

export async function disconnectStripe(): Promise<void> {
  const actor = await requireActor()
  assertPermitted(permissions.canAdminister(actor), 'disconnect Stripe')
  const run = actorRunner(actor)
  const account = await paymentAccountFor(run, actor.operatorId)
  if (account !== null) {
    const key = openSecret(account.secretKeyCipher, serverEnv().WHATSAPP_TOKEN_KEY)
    if (key !== null) await deleteStripeWebhook(key, account.webhookEndpointId)
  }
  await removePaymentAccount(run, actor.operatorId)
  revalidatePath('/settings/payments')
  revalidatePath('/autonomy')
}

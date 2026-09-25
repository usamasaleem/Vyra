import { openSecret } from '@vyra/contracts/secrets'
import { createStripeCheckout } from '@vyra/contracts/stripe'
import {
  attachCheckout, bookingChecklist, linkNeeded, paymentAccountFor, queueOutboundText, type QueryRunner,
} from '@vyra/db'

/**
 * A payment link, made and sent the moment a customer chooses to pay by link.
 *
 * It used to be a person's job: "Bookings → Attach and send". With the
 * operator's Stripe connected, the checkout is made for everything owed
 * except the deposit, attached to those lines, and sent in one message —
 * and Stripe's notice marks it paid, with nobody ticking anything.
 */
export type PaymentLinks = (input: { operatorId: string; conversationId: string; bookingId: string }) =>
  Promise<{ sent: boolean; url: string | null }>

export function paymentLinks(deps: {
  run: QueryRunner
  keyMaterial: string | undefined
  successUrl: string
  log: (fields: Record<string, unknown>) => void
  fetchImpl?: typeof fetch
}): PaymentLinks {
  return async ({ operatorId, conversationId, bookingId }) => {
    const list = await bookingChecklist(deps.run, { operatorId, bookingId })
    if (list === null || list.paymentPlan !== 'link' || list.owedMinor === 0) return { sent: false, url: null }
    const account = await paymentAccountFor(deps.run, operatorId)
    if (account === null) return { sent: false, url: null }
    const needed = await linkNeeded(deps.run, { operatorId, bookingId })
    if (needed === null) return { sent: false, url: null }
    // One link per checkout: an open one is the customer's already.
    if (needed.openLink !== null) return { sent: false, url: needed.openLink }

    const secret = openSecret(account.secretKeyCipher, deps.keyMaterial)
    if (secret === null) {
      deps.log({ event: 'payment_link.key_unreadable', operator: operatorId })
      return { sent: false, url: null }
    }
    const checkout = await createStripeCheckout(secret, {
      amountMinor: needed.amountMinor,
      currency: needed.currency,
      description: needed.description,
      successUrl: deps.successUrl,
      metadata: { operator_id: operatorId, booking_id: bookingId, conversation_id: conversationId },
    }, deps.fetchImpl)
    await attachCheckout(deps.run, {
      operatorId, paymentIds: needed.paymentIds, url: checkout.url, sessionId: checkout.id, expiresAt: checkout.expiresAt,
    })

    const amount = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(needed.amountMinor / 100)
    const deposit = list.depositMinor !== null && list.depositMinor > 0
    await queueOutboundText(deps.run, {
      conversationId, operatorId,
      body: `Here is your secure payment link for ${needed.currency} ${amount}${deposit ? ' — the rental; the deposit is taken at the handover' : ''}:\n${checkout.url}\n\n`
        + 'It is valid for 24 hours. You will get a message here as soon as the payment comes through.',
      idempotencyKey: `payment-link:${checkout.id}`,
    })
    deps.log({ event: 'payment_link.sent', booking: bookingId, amountMinor: needed.amountMinor, livemode: account.livemode })
    return { sent: true, url: checkout.url }
  }
}

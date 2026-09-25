import { openSecret } from '@vyra/contracts/secrets'
import { verifyStripeSignature } from '@vyra/contracts/stripe'
import { forgetCheckout, markCheckoutPaid, paymentAccountFor, queueOutboundText } from '@vyra/db'
import { queryRunner } from '@/lib/db'
import { serverEnv } from '@/lib/env'

/**
 * Stripe telling us a checkout was paid, or ran out.
 *
 * One endpoint per operator, registered when they connected Stripe, with the
 * operator in the address so the right signing secret is used. Privileged,
 * like the WhatsApp webhook: there is nobody signed in, and the signature is
 * what proves who is calling. Anything unsigned or unrecognised gets a 400 and
 * changes nothing.
 */
const log = (fields: Record<string, unknown>) => console.log(JSON.stringify(fields))

export async function POST(request: Request): Promise<Response> {
  const operatorId = new URL(request.url).searchParams.get('operator') ?? ''
  if (!/^[0-9a-f-]{36}$/.test(operatorId)) return new Response('Unknown operator', { status: 400 })

  const rawBody = await request.text()
  const run = queryRunner()
  const account = await paymentAccountFor(run, operatorId)
  const secret = account === null ? null : openSecret(account.webhookSecretCipher, serverEnv().WHATSAPP_TOKEN_KEY)
  if (secret === null || !verifyStripeSignature({ rawBody, header: request.headers.get('stripe-signature'), secret })) {
    log({ event: 'stripe.webhook_refused', operator: operatorId })
    return new Response('Bad signature', { status: 400 })
  }

  const event = JSON.parse(rawBody) as {
    type: string
    data: { object: { id: string; payment_status?: string; payment_intent?: string | null } }
  }
  const session = event.data.object

  if (event.type === 'checkout.session.completed' && session.payment_status === 'paid') {
    const paid = await markCheckoutPaid(run, { operatorId, sessionId: session.id, reference: session.payment_intent ?? null })
    if (paid !== null) {
      const amount = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(paid.paidMinor / 100)
      // Inside the 24 hours by nature: they paid from a link sent moments or hours ago.
      await queueOutboundText(run, {
        conversationId: paid.conversationId, operatorId,
        body: `Payment of ${paid.currency} ${amount} received — thank you. Your booking is paid.`,
        idempotencyKey: `paid:${session.id}`,
      }).catch(() => undefined)
      log({ event: 'stripe.paid', operator: operatorId, booking: paid.bookingId, amountMinor: paid.paidMinor })
    }
  } else if (event.type === 'checkout.session.expired') {
    await forgetCheckout(run, { operatorId, sessionId: session.id })
  }
  return new Response('ok')
}

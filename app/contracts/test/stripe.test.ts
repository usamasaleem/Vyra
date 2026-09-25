import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { createStripeCheckout, formEncode, verifyStripeSignature } from '../src/stripe.ts'

describe('talking to Stripe', () => {
  it('encodes nested fields the way Stripe reads them', () => {
    expect(formEncode({ mode: 'payment', line_items: [{ quantity: 1, price_data: { currency: 'aed', unit_amount: 1000 } }], metadata: { booking_id: 'b1' } }))
      .toEqual([
        'mode=payment',
        'line_items%5B0%5D%5Bquantity%5D=1',
        'line_items%5B0%5D%5Bprice_data%5D%5Bcurrency%5D=aed',
        'line_items%5B0%5D%5Bprice_data%5D%5Bunit_amount%5D=1000',
        'metadata%5Bbooking_id%5D=b1',
      ])
  })

  it('creates a checkout for the amount, in the right currency, with the booking on it', async () => {
    let sent = ''
    const fake = (async (_url: string, init: RequestInit) => {
      sent = String(init.body)
      return new Response(JSON.stringify({ id: 'cs_1', url: 'https://checkout.stripe.com/c/cs_1', expires_at: 1790000000 }), { status: 200 })
    }) as unknown as typeof fetch
    const session = await createStripeCheckout('sk_test_x', {
      amountMinor: 1500000, currency: 'AED', description: 'Ferrari 488 Spider, 26 to 28 September',
      successUrl: 'https://example.com/paid', metadata: { booking_id: 'b1', operator_id: 'o1' },
    }, fake)
    expect(session).toMatchObject({ id: 'cs_1', url: 'https://checkout.stripe.com/c/cs_1' })
    expect(decodeURIComponent(sent)).toContain('line_items[0][price_data][unit_amount]=1500000')
    expect(decodeURIComponent(sent)).toContain('line_items[0][price_data][currency]=aed')
    expect(decodeURIComponent(sent)).toContain('metadata[booking_id]=b1')
  })
})

describe("Stripe's signature", () => {
  const secret = 'whsec_test'
  const body = '{"type":"checkout.session.completed"}'
  const now = new Date('2026-09-25T10:00:00Z')
  const t = Math.floor(now.getTime() / 1000)
  const sign = (at: number, payload = body) => createHmac('sha256', secret).update(`${at}.${payload}`).digest('hex')

  it('accepts a notice Stripe signed', () => {
    expect(verifyStripeSignature({ rawBody: body, header: `t=${t},v1=${sign(t)}`, secret, now })).toBe(true)
  })
  it('refuses a body somebody changed', () => {
    expect(verifyStripeSignature({ rawBody: body.replace('completed', 'expired'), header: `t=${t},v1=${sign(t)}`, secret, now })).toBe(false)
  })
  it('refuses an old notice replayed', () => {
    expect(verifyStripeSignature({ rawBody: body, header: `t=${t - 600},v1=${sign(t - 600)}`, secret, now })).toBe(false)
  })
  it('refuses a missing signature', () => {
    expect(verifyStripeSignature({ rawBody: body, header: null, secret, now })).toBe(false)
  })
})

import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * The four things this product asks of Stripe, over fetch.
 *
 * No SDK, for the same reason the model adapters have none: four calls do not
 * justify a dependency, and a form-encoded POST is the whole of Stripe's API.
 * Written against Stripe's documentation for API version 2025 and later; the
 * version is pinned in the header so a change on Stripe's side cannot change
 * what these calls return.
 */
const API = 'https://api.stripe.com/v1'
const VERSION = '2025-08-27.basil'

export type StripeFetch = typeof fetch

export class StripeError extends Error {
  readonly status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = 'StripeError'
    this.status = status
  }
}

/** Stripe's form encoding: nested keys as a[b][c]=v. */
export function formEncode(value: Record<string, unknown>, prefix = ''): string[] {
  const out: string[] = []
  for (const [k, v] of Object.entries(value)) {
    if (v === undefined || v === null) continue
    const key = prefix === '' ? k : `${prefix}[${k}]`
    if (Array.isArray(v)) {
      v.forEach((item, i) => {
        if (typeof item === 'object' && item !== null) out.push(...formEncode(item as Record<string, unknown>, `${key}[${i}]`))
        else out.push(`${encodeURIComponent(`${key}[${i}]`)}=${encodeURIComponent(String(item))}`)
      })
    } else if (typeof v === 'object') {
      out.push(...formEncode(v as Record<string, unknown>, key))
    } else {
      out.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`)
    }
  }
  return out
}

async function call<T>(
  secretKey: string,
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  body?: Record<string, unknown>,
  doFetch: StripeFetch = fetch,
): Promise<T> {
  const response = await doFetch(`${API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${secretKey}`,
      'stripe-version': VERSION,
      ...(body === undefined ? {} : { 'content-type': 'application/x-www-form-urlencoded' }),
    },
    ...(body === undefined ? {} : { body: formEncode(body).join('&') }),
    signal: AbortSignal.timeout(20_000),
  })
  const json = await response.json() as T & { error?: { message?: string } }
  if (!response.ok) throw new StripeError(json.error?.message ?? `Stripe ${response.status}`, response.status)
  return json
}

export async function stripeAccount(secretKey: string, doFetch?: StripeFetch): Promise<{ id: string; livemode: boolean; country: string | null }> {
  const account = await call<{ id: string; country?: string }>(secretKey, 'GET', '/account', undefined, doFetch)
  return { id: account.id, livemode: secretKey.includes('_live_'), country: account.country ?? null }
}

export async function createStripeWebhook(
  secretKey: string,
  url: string,
  doFetch?: StripeFetch,
): Promise<{ id: string; secret: string }> {
  const endpoint = await call<{ id: string; secret: string }>(secretKey, 'POST', '/webhook_endpoints', {
    url,
    enabled_events: ['checkout.session.completed', 'checkout.session.expired'],
    description: 'Vyra: confirms payments on bookings',
  }, doFetch)
  return { id: endpoint.id, secret: endpoint.secret }
}

export async function deleteStripeWebhook(secretKey: string, id: string, doFetch?: StripeFetch): Promise<void> {
  await call(secretKey, 'DELETE', `/webhook_endpoints/${id}`, undefined, doFetch).catch(() => undefined)
}

/**
 * A hosted checkout for one amount. Twenty-four hours is Stripe's longest, so
 * an unpaid one is replaced with a fresh one when it is next needed.
 */
export async function createStripeCheckout(
  secretKey: string,
  input: {
    amountMinor: number
    currency: string
    description: string
    successUrl: string
    metadata: Record<string, string>
    customerPhone?: string | null
  },
  doFetch?: StripeFetch,
): Promise<{ id: string; url: string; expiresAt: Date }> {
  const session = await call<{ id: string; url: string; expires_at: number }>(secretKey, 'POST', '/checkout/sessions', {
    mode: 'payment',
    success_url: input.successUrl,
    line_items: [{
      quantity: 1,
      price_data: {
        currency: input.currency.toLowerCase(),
        unit_amount: input.amountMinor,
        product_data: { name: input.description },
      },
    }],
    metadata: input.metadata,
    payment_intent_data: { metadata: input.metadata, description: input.description },
  }, doFetch)
  return { id: session.id, url: session.url, expiresAt: new Date(session.expires_at * 1000) }
}

/**
 * Stripe's signature on a webhook: HMAC-SHA256 of "timestamp.body" with the
 * endpoint's secret, in the Stripe-Signature header as t=…,v1=…. Five minutes
 * of tolerance, as Stripe recommends, so a replayed old notice is refused.
 */
export function verifyStripeSignature(input: {
  rawBody: string
  header: string | null
  secret: string
  now?: Date
  toleranceSeconds?: number
}): boolean {
  if (input.header === null) return false
  const parts = new Map<string, string[]>()
  for (const piece of input.header.split(',')) {
    const [k, v] = piece.split('=')
    if (k === undefined || v === undefined) continue
    parts.set(k.trim(), [...(parts.get(k.trim()) ?? []), v.trim()])
  }
  const timestamp = Number(parts.get('t')?.[0])
  if (!Number.isFinite(timestamp)) return false
  const age = (input.now ?? new Date()).getTime() / 1000 - timestamp
  if (Math.abs(age) > (input.toleranceSeconds ?? 300)) return false
  const expected = createHmac('sha256', input.secret).update(`${timestamp}.${input.rawBody}`).digest()
  return (parts.get('v1') ?? []).some((sig) => {
    const given = Buffer.from(sig, 'hex')
    return given.length === expected.length && timingSafeEqual(given, expected)
  })
}

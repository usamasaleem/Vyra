import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { paymentLinks } from '../src/payment-links.ts'
import { sealSecret } from '../../contracts/src/secrets.ts'
import { forgetCheckout, markCheckoutPaid } from '../../db/src/queries/payment-accounts.ts'
import type { QueryRunner } from '../../db/src/runner.ts'

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'db', 'migrations')
const OP = '11111111-1111-1111-1111-111111111111'
const ACCOUNT = '33333333-3333-3333-3333-333333333333'
const CONTACT = '55555555-5555-5555-5555-555555555555'
const CONV = '66666666-6666-6666-6666-666666666666'

let db: PGlite
let run: QueryRunner

beforeEach(async () => {
  db = await PGlite.create()
  run = async (t, p) => (await db.query(t, p)).rows as Array<Record<string, unknown>>
  for (const f of readdirSync(migrationsDir).filter((n) => n.endsWith('.sql')).sort()) {
    await db.exec(readFileSync(join(migrationsDir, f), 'utf8'))
  }
  await db.exec(`
    insert into operators (id, name, timezone) values ('${OP}', 'Vyra Pilot', 'Asia/Dubai');
    insert into whatsapp_accounts (id, operator_id, provider_account_id, phone_number_id)
    values ('${ACCOUNT}', '${OP}', 'waba', '111');
    insert into contacts (id, operator_id, channel_identifier) values ('${CONTACT}', '${OP}', '9715001');
    insert into conversations (id, operator_id, contact_id, whatsapp_account_id)
    values ('${CONV}', '${OP}', '${CONTACT}', '${ACCOUNT}');
  `)
})

const KEY = Buffer.alloc(32, 7).toString('base64')
const MEMBER = '88888888-8888-8888-8888-888888888888'
let bookingId = ''

beforeEach(async () => {
  await db.exec(`
    insert into memberships (id, operator_id, user_id, role) values ('${MEMBER}', '${OP}', '99999999-9999-9999-9999-999999999999', 'admin');
    insert into vehicles (id, operator_id, make, model, variant, year, colour, category, plate, chassis_number, provenance, confirmed_by)
    values ('44444444-4444-4444-4444-444444444444', '${OP}', 'Ferrari', '488', 'Spider', 2022, 'Giallo', 'exotic', 'D 9', 'V9', 'operator_confirmed', 'Owner');
  `)
  const [e] = await run(`insert into enquiries (operator_id, conversation_id) values ($1, $2) returning id`, [OP, CONV])
  const [q] = await run(
    `insert into quotes (operator_id, conversation_id, enquiry_id, vehicle_id, revision, state, total_minor, deposit_minor, lines,
                         start_date, end_date, days, approved_by_membership_id, approved_at)
     values ($1, $2, $3, '44444444-4444-4444-4444-444444444444', 1, 'sent', 1000000, 500000, '[]'::jsonb,
             '2026-09-26', '2026-09-28', 2, $4, now()) returning id`, [OP, CONV, e!['id'], MEMBER])
  const [b] = await run(
    `insert into bookings (operator_id, conversation_id, enquiry_id, quote_id, state, decided_at, payment_plan)
     values ($1, $2, $3, $4, 'confirmed', now(), 'link') returning id`, [OP, CONV, e!['id'], q!['id']])
  bookingId = b!['id'] as string
  await run(
    `insert into payments (operator_id, booking_id, conversation_id, kind, state, amount_minor, currency, label)
     values ($1, $2, $3, 'rental', 'due', 1000000, 'AED', null), ($1, $2, $3, 'deposit', 'due', 500000, 'AED', null),
            ($1, $2, $3, 'add_on', 'due', 160000, 'AED', 'Chauffeur, 2 days')`, [OP, bookingId, CONV])
  await run(
    `insert into payment_accounts (operator_id, provider, secret_key_cipher, secret_key_hint, webhook_secret_cipher,
                                   webhook_endpoint_id, account_id, livemode)
     values ($1, 'stripe', $2, '1234', $3, 'we_1', 'acct_1', false)`,
    [OP, sealSecret('sk_test_abc', KEY), sealSecret('whsec_x', KEY)])
})

const stripe = () => {
  const calls: string[] = []
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    calls.push(decodeURIComponent(String(init.body)))
    return new Response(JSON.stringify({ id: `cs_${calls.length}`, url: `https://checkout.stripe.com/c/cs_${calls.length}`, expires_at: Math.floor(Date.now() / 1000) + 86400 }), { status: 200 })
  }) as unknown as typeof fetch
  return { calls, fetchImpl }
}
const log = () => {}

describe('payment links through Stripe', () => {
  it('makes one checkout for everything owed but the deposit, attaches it, and sends it', async () => {
    const { calls, fetchImpl } = stripe()
    const send = paymentLinks({ run, keyMaterial: KEY, successUrl: 'https://x/paid', log, fetchImpl })
    expect(await send({ operatorId: OP, conversationId: CONV, bookingId })).toEqual({ sent: true, url: 'https://checkout.stripe.com/c/cs_1' })
    expect(calls[0]).toContain('line_items[0][price_data][unit_amount]=1160000')
    const [m] = await run(`select body from messages where direction = 'outbound'`, [])
    expect(m!['body']).toMatch(/^Here is your secure payment link for AED 11,600 — the rental; the deposit is taken at the handover:\nhttps:\/\/checkout\.stripe\.com\/c\/cs_1/)
    expect(await run(`select kind::text as kind, link_session_id from payments order by kind::text`, []))
      .toEqual([{ kind: 'add_on', link_session_id: 'cs_1' }, { kind: 'deposit', link_session_id: null }, { kind: 'rental', link_session_id: 'cs_1' }])

    // Asked again while it is open: the same link, not a second checkout.
    expect(await send({ operatorId: OP, conversationId: CONV, bookingId })).toEqual({ sent: false, url: 'https://checkout.stripe.com/c/cs_1' })
    expect(calls).toHaveLength(1)
  })

  it('marks the lines paid when Stripe says so, and leaves the deposit owed', async () => {
    const { fetchImpl } = stripe()
    await paymentLinks({ run, keyMaterial: KEY, successUrl: 'https://x/paid', log, fetchImpl })({ operatorId: OP, conversationId: CONV, bookingId })
    expect(await markCheckoutPaid(run, { operatorId: OP, sessionId: 'cs_1', reference: 'pi_1' }))
      .toMatchObject({ bookingId, paidMinor: 1160000, currency: 'AED' })
    expect(await run(`select kind::text as kind, state::text as state, method::text as method from payments order by kind::text`, []))
      .toEqual([
        { kind: 'add_on', state: 'paid', method: 'link' },
        { kind: 'deposit', state: 'due', method: null },
        { kind: 'rental', state: 'paid', method: 'link' },
      ])
    // Stripe retries a notice; the second changes nothing.
    expect(await markCheckoutPaid(run, { operatorId: OP, sessionId: 'cs_1', reference: 'pi_1' })).toBeNull()
  })

  it('makes a fresh one after the old one ran out unpaid', async () => {
    const { calls, fetchImpl } = stripe()
    const send = paymentLinks({ run, keyMaterial: KEY, successUrl: 'https://x/paid', log, fetchImpl })
    await send({ operatorId: OP, conversationId: CONV, bookingId })
    await forgetCheckout(run, { operatorId: OP, sessionId: 'cs_1' })
    expect(await send({ operatorId: OP, conversationId: CONV, bookingId })).toMatchObject({ sent: true, url: 'https://checkout.stripe.com/c/cs_2' })
    expect(calls).toHaveLength(2)
  })

  it('does nothing unless they chose a link and Stripe is connected', async () => {
    const { calls, fetchImpl } = stripe()
    await run(`update bookings set payment_plan = 'transfer'`, [])
    const send = paymentLinks({ run, keyMaterial: KEY, successUrl: 'https://x/paid', log, fetchImpl })
    expect(await send({ operatorId: OP, conversationId: CONV, bookingId })).toEqual({ sent: false, url: null })
    await run(`update bookings set payment_plan = 'link'`, [])
    await run(`delete from payment_accounts`, [])
    expect(await send({ operatorId: OP, conversationId: CONV, bookingId })).toEqual({ sent: false, url: null })
    expect(calls).toHaveLength(0)
  })
})

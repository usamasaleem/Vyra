import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { beforeEach, describe, expect, it } from 'vitest'
import { requestBooking } from '../src/queries/bookings.ts'
import { applyStandingDiscount } from '../src/queries/standing-discount.ts'
import type { QueryRunner, Transactor } from '../src/runner.ts'

/**
 * What the agent may do on its own, and no more: the operator's limits on
 * self-booking, and the money off they have already agreed to give.
 */
const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations')
const OP = '11111111-1111-1111-1111-111111111111'
const ACCOUNT = '33333333-3333-3333-3333-333333333333'
const CAR = '44444444-4444-4444-4444-444444444444'
const CONV = '66666666-6666-6666-6666-666666666666'
const OWNER = '88888888-8888-8888-8888-888888888888'

let db: PGlite
let run: QueryRunner
let transact: Transactor

beforeEach(async () => {
  db = await PGlite.create()
  run = async (t, p) => (await db.query(t, p)).rows as Array<Record<string, unknown>>
  transact = async (fn) => {
    let out: unknown
    await db.transaction(async (tx) => {
      out = await fn(async (text, params) => (await tx.query(text, params)).rows as Array<Record<string, unknown>>)
    })
    return out as never
  }
  for (const f of readdirSync(migrationsDir).filter((n) => n.endsWith('.sql')).sort()) {
    await db.exec(readFileSync(join(migrationsDir, f), 'utf8'))
  }
  await db.exec(`
    insert into operators (id, name, timezone, availability_calendar_complete, auto_confirm_bookings,
                           auto_confirm_limit_minor, auto_confirm_max_days)
    values ('${OP}', 'Vyra Pilot', 'Asia/Dubai', true, true, 5000000, 14);
    insert into memberships (id, operator_id, user_id, role, display_name)
    values ('${OWNER}', '${OP}', '99999999-9999-9999-9999-999999999999', 'admin', 'Usama');
    update operators set discount_tiers = '[{"minDays":5,"percent":10},{"minDays":7,"percent":15}]',
                         discount_tiers_set_by_membership_id = '${OWNER}';
    insert into whatsapp_accounts (id, operator_id, provider_account_id, phone_number_id)
    values ('${ACCOUNT}', '${OP}', 'waba', '111');
    insert into contacts (id, operator_id, channel_identifier)
    values ('55555555-5555-5555-5555-555555555555', '${OP}', '9715001');
    insert into conversations (id, operator_id, contact_id, whatsapp_account_id)
    values ('${CONV}', '${OP}', '55555555-5555-5555-5555-555555555555', '${ACCOUNT}');
    insert into vehicles (id, operator_id, make, model, variant, year, colour, category,
                          plate, chassis_number, provenance, confirmed_by)
    values ('${CAR}', '${OP}', 'Lamborghini', 'Huracán', 'Tecnica', 2023, 'Verde', 'exotic',
            'D 2', 'V2', 'operator_confirmed', 'Owner');
  `)
})

/** A quote for `days` days at AED 5,000 a day. */
const quote = async (days: number) => {
  const [e] = await run(
    `insert into enquiries (operator_id, conversation_id) values ($1, $2) returning id`, [OP, CONV])
  const [q] = await run(
    `insert into quotes (operator_id, conversation_id, enquiry_id, vehicle_id, revision, state,
                         currency, total_minor, deposit_minor, lines, start_date, end_date, days, valid_until)
     values ($1, $2, $3, $4, 1, 'draft', 'AED', $5, 500000, '[]'::jsonb, '2099-01-01',
             ('2099-01-01'::date + $6::int)::timestamptz, $6, now() + interval '2 days') returning id`,
    [OP, CONV, e!['id'], CAR, days * 500000, days])
  return { quoteId: q!['id'] as string, enquiryId: e!['id'] as string }
}

describe('limits on booking alone', () => {
  it('confirms an ordinary rental', async () => {
    const { quoteId, enquiryId } = await quote(3)
    expect(await requestBooking(transact, { operatorId: OP, conversationId: CONV, enquiryId, quoteId }))
      .toMatchObject({ ok: true, booking: { confirmed: true } })
  })

  /** Live: a Lamborghini confirmed for 365 days, overnight, with nobody asked. */
  it('leaves a rental longer than the limit for a person, and says why', async () => {
    await run(`update operators set auto_confirm_limit_minor = null`, [])
    const { quoteId, enquiryId } = await quote(20)
    const result = await requestBooking(transact, { operatorId: OP, conversationId: CONV, enquiryId, quoteId })
    expect(result).toMatchObject({ ok: true, booking: { confirmed: false, waitsBecause: 'too_long' } })
  })

  it('leaves a total above the ceiling for a person, and says why', async () => {
    const { quoteId, enquiryId } = await quote(12)
    const result = await requestBooking(transact, { operatorId: OP, conversationId: CONV, enquiryId, quoteId })
    expect(result).toMatchObject({ ok: true, booking: { confirmed: false, waitsBecause: 'too_large' } })
  })
})

describe('money off the operator already agreed to', () => {
  const apply = (quoteId: string) =>
    applyStandingDiscount(transact, { operatorId: OP, conversationId: CONV, quoteId })

  it('takes the best tier the rental reaches', async () => {
    const { quoteId } = await quote(7)
    expect(await apply(quoteId)).toMatchObject({
      ok: true, percent: 15, totalMinor: 2975000, discountMinor: 525000,
    })
  })

  it('writes a new revision and leaves the old price on file', async () => {
    const { quoteId } = await quote(5)
    const applied = await apply(quoteId) as { quoteId: string }
    const rows = await run(`select id, state::text as state, total_minor, discount_reason from quotes order by revision`, [])
    expect(rows[0]).toMatchObject({ id: quoteId, state: 'superseded', total_minor: 2500000 })
    expect(rows[1]).toMatchObject({
      id: applied.quoteId, state: 'approved', total_minor: 2250000,
      discount_reason: 'Standing offer: 10% off rentals of 5+ days',
    })
  })

  it('names the next tier when the rental is short of one', async () => {
    const { quoteId } = await quote(3)
    expect(await apply(quoteId)).toMatchObject({
      ok: false, reason: 'not_eligible', nextTier: { minDays: 5, percent: 10 },
    })
  })

  /** Once per price: more than the standing offer is a person's decision. */
  it('will not discount a discounted price', async () => {
    const { quoteId } = await quote(7)
    const applied = await apply(quoteId) as { quoteId: string }
    expect(await apply(applied.quoteId)).toMatchObject({ ok: false, reason: 'already_discounted' })
  })

  it('gives nothing where the operator set no tiers', async () => {
    await run(`update operators set discount_tiers = null, discount_tiers_set_by_membership_id = null`, [])
    const { quoteId } = await quote(7)
    expect(await apply(quoteId)).toMatchObject({ ok: false, reason: 'no_rules' })
  })
})

import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { beforeEach, describe, expect, it } from 'vitest'
import { requestBooking } from '../src/queries/bookings.ts'
import { addToBooking } from '../src/queries/add-ons.ts'
import { bookingChecklist } from '../src/queries/booking-checklist.ts'
import { renderBookingSummary } from '../src/queries/booking-messages.ts'
import type { QueryRunner, Transactor } from '../src/runner.ts'

/**
 * Extras on a booking, at the operator's own prices: a chauffeur by the day,
 * more kilometres once.
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
                         discount_tiers_set_by_membership_id = '${OWNER}',
      add_ons = '[{"id":"chauffeur","name":"Chauffeur","priceMinor":80000,"per":"day"},{"id":"extra-100-km","name":"Extra 100 km","priceMinor":50000,"per":"rental"}]';
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

/** A confirmed three-day rental: AED 15,000 and a AED 5,000 deposit. */
const booked = async () => {
  const [e] = await run(`insert into enquiries (operator_id, conversation_id) values ($1, $2) returning id`, [OP, CONV])
  const [q] = await run(
    `insert into quotes (operator_id, conversation_id, enquiry_id, vehicle_id, revision, state, currency,
                         total_minor, deposit_minor, lines, start_date, end_date, days, valid_until)
     values ($1, $2, $3, $4, 1, 'draft', 'AED', 1500000, 500000, '[]'::jsonb, '2099-01-01', '2099-01-04', 3,
             now() + interval '2 days') returning id`,
    [OP, CONV, e!['id'], CAR])
  const r = await requestBooking(transact, { operatorId: OP, conversationId: CONV, enquiryId: e!['id'] as string, quoteId: q!['id'] as string })
  return (r as { booking: { bookingId: string } }).booking.bookingId
}

const add = (bookingId: string, addOnId: string) =>
  addToBooking(transact, { operatorId: OP, bookingId, addOnId })

describe('extras on a booking', () => {
  it('prices a per-day extra by the rental days', async () => {
    expect(await add(await booked(), 'chauffeur')).toMatchObject({
      ok: true, label: 'Chauffeur, 3 days', amountMinor: 240000, owedMinor: 2240000,
    })
  })

  it('prices a per-rental extra once', async () => {
    expect(await add(await booked(), 'extra-100-km')).toMatchObject({
      ok: true, label: 'Extra 100 km', amountMinor: 50000,
    })
  })

  it('adds each extra once', async () => {
    const id = await booked()
    await add(id, 'chauffeur')
    expect(await add(id, 'chauffeur')).toMatchObject({ ok: false, reason: 'already_added' })
  })

  /** The agent names an extra; only the operator's list decides what exists. */
  it('refuses an extra the operator does not offer', async () => {
    expect(await add(await booked(), 'helicopter')).toMatchObject({ ok: false, reason: 'unknown' })
  })

  it('shows on the booking and in the summary', async () => {
    const id = await booked()
    await add(id, 'chauffeur')
    const list = (await bookingChecklist(run, { operatorId: OP, bookingId: id }))!
    expect(list.addOns).toEqual([{ label: 'Chauffeur, 3 days', amountMinor: 240000 }])
    expect(renderBookingSummary(list, { collectionPoint: null })).toContain('Extra: Chauffeur, 3 days — AED 2,400')
  })
})

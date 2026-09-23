import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  activeBookingFor, bookingChecklist, markReturned, recordBookingProgress,
} from '../src/queries/booking-checklist.ts'
import { renderBookingSummary, renderHandoverFacts, summaryKey } from '../src/queries/booking-messages.ts'
import { dueReminders } from '../src/queries/reminders.ts'
import { decideBooking, requestBooking } from '../src/queries/bookings.ts'
import type { QueryRunner, Transactor } from '../src/runner.ts'

/**
 * After "Booked": the whole booking back to the customer once it is complete,
 * a message the day before each end of the rental, and the car marked back.
 */
const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations')
const OP = '11111111-1111-1111-1111-111111111111'
const ACCOUNT = '33333333-3333-3333-3333-333333333333'
const MEMBER = '88888888-8888-8888-8888-888888888888'
const CONTACT = '55555555-5555-5555-5555-555555555555'
const CONV = '66666666-6666-6666-6666-666666666666'
const CAR = '44444444-4444-4444-4444-444444444444'

let db: PGlite
let run: QueryRunner
let transact: Transactor
let enquiryId: string

/** Noon in Dubai on 1 October. */
const NOON = new Date('2026-10-01T08:00:00Z')

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
    insert into operators (id, name, timezone, availability_calendar_complete)
    values ('${OP}', 'Vyra Pilot', 'Asia/Dubai', true);
    insert into memberships (id, operator_id, user_id, role, display_name)
    values ('${MEMBER}', '${OP}', '99999999-9999-9999-9999-999999999999', 'salesperson', 'Ahmed');
    insert into whatsapp_accounts (id, operator_id, provider_account_id, phone_number_id)
    values ('${ACCOUNT}', '${OP}', 'waba', '111');
    insert into contacts (id, operator_id, channel_identifier) values ('${CONTACT}', '${OP}', '9715001');
    insert into conversations (id, operator_id, contact_id, whatsapp_account_id)
    values ('${CONV}', '${OP}', '${CONTACT}', '${ACCOUNT}');
    insert into vehicles (id, operator_id, make, model, variant, year, colour, category,
                          plate, chassis_number, provenance, confirmed_by)
    values ('${CAR}', '${OP}', 'Ferrari', '488', 'Spider', 2022, 'Giallo', 'exotic',
            'D 2', 'V2', 'operator_confirmed', 'Owner');
  `)
  const [e] = await run(
    `insert into enquiries (operator_id, conversation_id) values ($1,$2) returning id`, [OP, CONV])
  enquiryId = e!['id'] as string
})

const booked = async (start: string, end: string, preference: 'delivery' | 'collection' = 'delivery') => {
  await run(
    `insert into field_evidence (operator_id, enquiry_id, field, value)
     values ($1, $2, 'delivery_preference', $3)`, [OP, enquiryId, preference])
  const [q] = await run(
    `insert into quotes (operator_id, conversation_id, enquiry_id, vehicle_id, revision, state,
                         total_minor, deposit_minor, lines, start_date, end_date, days,
                         valid_until, approved_by_membership_id, approved_at)
     values ($1,$2,$3,$4,1,'sent',1500000,500000,'[]'::jsonb,$5::timestamptz,$6::timestamptz,3,
             now() + interval '5 days',$7,now()) returning id`,
    [OP, CONV, enquiryId, CAR, start, end, MEMBER])
  const r = await requestBooking(transact, {
    operatorId: OP, conversationId: CONV, enquiryId, quoteId: q!['id'] as string,
  })
  const id = (r as { booking: { bookingId: string } }).booking.bookingId
  await decideBooking(transact, { operatorId: OP, bookingId: id, membershipId: MEMBER, decision: 'confirmed' })
  // Confirmed a while ago, so the day-before message is not suppressed as fresh.
  await run(`update bookings set decided_at = '2026-09-20T08:00:00Z' where id = $1`, [id])
  return id
}

const inbound = () => run(
  `insert into messages (operator_id, conversation_id, direction, kind, body, provider_id)
   values ($1, $2, 'inbound', 'text', 'hi', $3) returning id`, [OP, CONV, `wamid.${Math.random()}`])

describe('the summary', () => {
  it('says the whole booking, from the record', async () => {
    const id = await booked('2026-10-02', '2026-10-05')
    await recordBookingProgress(run, {
      operatorId: OP, bookingId: id, deliveryAddress: 'Marina Gate 2, Apt 1904', deliveryTime: '10:00',
      paymentPlan: 'on_delivery',
    })
    const text = renderBookingSummary((await bookingChecklist(run, { operatorId: OP, bookingId: id }))!, {
      collectionPoint: null,
    })
    expect(text).toContain('*Ferrari 488 Spider*')
    expect(text).toContain('Friday 2 October to Monday 5 October (3 days)')
    expect(text).toContain('Delivery: Friday 2 October at 10:00, to Marina Gate 2, Apt 1904')
    expect(text).toContain('Rental: AED 15,000 · refundable deposit: AED 5,000')
    expect(text).toContain('Payment: AED 20,000, by card or cash at the handover')
    expect(text).toContain('Returning: Monday 5 October')
  })

  it('names the collection point in the operator\u2019s words', async () => {
    const id = await booked('2026-10-02', '2026-10-05', 'collection')
    await recordBookingProgress(run, { operatorId: OP, bookingId: id, deliveryTime: '16:00' })
    const text = renderBookingSummary((await bookingChecklist(run, { operatorId: OP, bookingId: id }))!, {
      collectionPoint: 'Our showroom on Sheikh Zayed Road',
    })
    expect(text).toContain('Collection: Friday 2 October at 16:00 — Our showroom on Sheikh Zayed Road')
  })

  /** A payment being marked taken changes the words, not the plan. */
  it('is about the plan, so money arriving does not send it again', async () => {
    const id = await booked('2026-10-02', '2026-10-05')
    const before = summaryKey((await bookingChecklist(run, { operatorId: OP, bookingId: id }))!)
    await run(`update payments set state = 'paid', method = 'cash', paid_at = now(),
               recorded_by_membership_id = $2 where booking_id = $1`, [id, MEMBER])
    expect(summaryKey((await bookingChecklist(run, { operatorId: OP, bookingId: id }))!)).toBe(before)

    await recordBookingProgress(run, { operatorId: OP, bookingId: id, deliveryTime: '11:00' })
    expect(summaryKey((await bookingChecklist(run, { operatorId: OP, bookingId: id }))!)).not.toBe(before)
  })

  it('lists what is still missing under the day-before message', async () => {
    const id = await booked('2026-10-02', '2026-10-05')
    const facts = renderHandoverFacts((await bookingChecklist(run, { operatorId: OP, bookingId: id }))!, {
      collectionPoint: null,
    })
    expect(facts).toContain('Payment: AED 20,000 still to pay')
    expect(facts).toContain('Documents: still needed')
  })
})

describe('the day before', () => {
  it('finds the car going out tomorrow, in the daytime', async () => {
    const id = await booked('2026-10-02', '2026-10-05')
    await inbound()
    const due = await dueReminders(run, { now: NOON })
    expect(due).toEqual([expect.objectContaining({ kind: 'handover-reminder', bookingId: id, forDate: '2026-10-02' })])
  })

  it('waits for daytime', async () => {
    await booked('2026-10-02', '2026-10-05')
    // 02:00 in Dubai.
    expect(await dueReminders(run, { now: new Date('2026-09-30T22:00:00Z') })).toEqual([])
  })

  it('does not remind somebody who booked this morning', async () => {
    const id = await booked('2026-10-02', '2026-10-05')
    await run(`update bookings set decided_at = $2 where id = $1`, [id, '2026-10-01T06:00:00Z'])
    expect(await dueReminders(run, { now: NOON })).toEqual([])
  })

  it('sends each reminder once', async () => {
    const id = await booked('2026-10-02', '2026-10-05')
    await run(
      `insert into messages (operator_id, conversation_id, direction, kind, body, idempotency_key)
       values ($1, $2, 'outbound', 'text', 'x', $3)`,
      [OP, CONV, `handover-reminder:${id}:2026-10-02`])
    expect(await dueReminders(run, { now: NOON })).toEqual([])
  })

  it('asks about the return the day before it is due', async () => {
    const id = await booked('2026-09-29', '2026-10-02')
    const due = await dueReminders(run, { now: NOON })
    expect(due).toEqual([expect.objectContaining({ kind: 'return-reminder', bookingId: id })])
  })

  it('does not ask about a return they have already arranged', async () => {
    const id = await booked('2026-09-29', '2026-10-02')
    await recordBookingProgress(run, { operatorId: OP, bookingId: id, returnTime: '18:00' })
    expect(await dueReminders(run, { now: NOON })).toEqual([])
  })
})

describe('coming back', () => {
  it('is marked with the name of whoever saw it, once', async () => {
    const id = await booked('2026-09-29', '2026-10-02')
    expect(await markReturned(run, { operatorId: OP, bookingId: id, membershipId: MEMBER }))
      .toEqual({ returned: true, conversationId: CONV })
    expect(await markReturned(run, { operatorId: OP, bookingId: id, membershipId: MEMBER }))
      .toEqual({ returned: false, conversationId: null })
  })

  it('is no longer the booking the agent is working on', async () => {
    const id = await booked('2099-01-01', '2099-01-03')
    await markReturned(run, { operatorId: OP, bookingId: id, membershipId: MEMBER })
    expect(await activeBookingFor(run, { operatorId: OP, conversationId: CONV })).toBeNull()
  })

  it('records when and where the car comes back', async () => {
    const id = await booked('2099-01-01', '2099-01-03')
    await recordBookingProgress(run, {
      operatorId: OP, bookingId: id, returnTime: '18:30', returnAddress: 'Same as delivery',
    })
    expect(await bookingChecklist(run, { operatorId: OP, bookingId: id }))
      .toMatchObject({ returnTime: '18:30', returnAddress: 'Same as delivery' })
  })
})


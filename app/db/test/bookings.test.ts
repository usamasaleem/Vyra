import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  bookingsOnFile, cancelBooking, decideBooking, listBookingRequests, listConfirmedBookings,
  requestBooking,
} from '../src/queries/bookings.ts'
import { listDraftQuotes } from '../src/queries/quotes.ts'
import type { QueryRunner, Transactor } from '../src/runner.ts'

/**
 * The bottom of the funnel, which did not exist.
 *
 * `request_booking_review` refused every call it ever received, so a customer
 * agreeing to a price became a handoff with no figures attached — in the same
 * queue, in the same words, as somebody asking about parking. Three quotes
 * were sent during the pilot and `booking_status` read 'none' on every
 * conversation in the database.
 */
const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations')
const OP = '11111111-1111-1111-1111-111111111111'
const CONTACT = '55555555-5555-5555-5555-555555555555'
const CONV = '66666666-6666-6666-6666-666666666666'
const MEMBER = '88888888-8888-8888-8888-888888888888'
const CAR = '44444444-4444-4444-4444-444444444444'

let db: PGlite
let run: QueryRunner
let transact: Transactor
let enquiryId: string

const NOW = new Date('2026-09-18T08:00:00Z')

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
    insert into operators (id, name) values ('${OP}', 'Vyra Pilot');
    insert into memberships (id, operator_id, user_id, role, display_name)
    values ('${MEMBER}', '${OP}', '99999999-9999-9999-9999-999999999999', 'salesperson', 'Ahmed');
    insert into whatsapp_accounts (id, operator_id, provider_account_id, phone_number_id)
    values ('33333333-3333-3333-3333-333333333333', '${OP}', 'waba', '111');
    insert into contacts (id, operator_id, channel_identifier, display_name)
    values ('${CONTACT}', '${OP}', '971500000001', 'Umer');
    insert into conversations (id, operator_id, contact_id, whatsapp_account_id)
    values ('${CONV}', '${OP}', '${CONTACT}', '33333333-3333-3333-3333-333333333333');
    insert into vehicles (id, operator_id, make, model, variant, year, colour, category,
                          plate, chassis_number, provenance, confirmed_by)
    values ('${CAR}', '${OP}', 'Ferrari', '488', 'Spider', 2022, 'Giallo', 'exotic',
            'D 2', 'V2', 'operator_confirmed', 'Owner');
  `)
  const e = await run(
    `insert into enquiries (operator_id, conversation_id) values ($1, $2) returning id`, [OP, CONV])
  enquiryId = e[0]!['id'] as string
})

const sentQuote = async (over: Record<string, unknown> = {}) => {
  const rows = await run(
    `insert into quotes (operator_id, conversation_id, enquiry_id, vehicle_id, revision, state,
                         total_minor, deposit_minor, lines, start_date, end_date, days,
                         valid_until, approved_by_membership_id, approved_at)
     values ($1, $2, $3, $7, coalesce($4, 1), 'sent', 500000, 300000, '[]'::jsonb,
             coalesce($8::timestamptz, '2026-09-20'), coalesce($9::timestamptz, '2026-09-21'),
             1, $5, $6, now())
     returning id`,
    [
      OP, CONV, (over['enquiryId'] as string) ?? enquiryId, over['revision'] ?? null,
      (over['validUntil'] as Date) ?? new Date('2026-09-25T00:00:00Z'), MEMBER,
      (over['vehicleId'] as string) ?? CAR,
      (over['startDate'] as string) ?? null, (over['endDate'] as string) ?? null,
    ],
  )
  return rows[0]!['id'] as string
}

const request = (quoteId: string) =>
  requestBooking(transact, {
    operatorId: OP, conversationId: CONV, enquiryId, quoteId, now: NOW,
  })

describe('somebody said yes', () => {
  it('appears in the queue with the figures they agreed to', async () => {
    await request(await sentQuote())

    const [waiting] = await listBookingRequests(run, OP)
    expect(waiting).toMatchObject({
      customer: '971500000001',
      customerName: 'Umer',
      totalMinor: 500000,
      depositMinor: 300000,
      days: 1,
    })
  })

  /**
   * Oldest first. Everybody here has already committed, and a newest-first
   * queue starves its oldest item — which is how two handoffs from the
   * fifteenth were still open on the eighteenth.
   */
  it('puts the person who has waited longest at the top', async () => {
    const first = await request(await sentQuote({ revision: 1 }))
    await run(`update bookings set requested_at = now() - interval '2 hours' where id = $1`,
      [(first as { booking: { bookingId: string } }).booking.bookingId])
    // A genuinely different rental. Same car and dates in the same thread is
    // now the one they already have rather than a second thing to answer.
    await request(await sentQuote({
      revision: 2, startDate: '2026-10-10', endDate: '2026-10-12',
    }))

    const queue = await listBookingRequests(run, OP)
    expect(queue).toHaveLength(2)
    expect(queue[0]!.bookingId).toBe((first as { booking: { bookingId: string } }).booking.bookingId)
  })
})

describe('answering them', () => {
  const confirm = (bookingId: string, decision: 'confirmed' | 'declined' = 'confirmed') =>
    decideBooking(transact, { operatorId: OP, bookingId, membershipId: MEMBER, decision })

  const bookingId = async () => {
    const result = await request(await sentQuote())
    return (result as { booking: { bookingId: string } }).booking.bookingId
  }

  it('carries the name of whoever decided it', async () => {
    const id = await bookingId()
    expect(await confirm(id)).toMatchObject({ decided: true, conversationId: CONV })

    const [row] = await run(
      `select state::text as state, decided_by_membership_id, decided_at
       from bookings where id = $1`, [id])
    expect(row).toMatchObject({ state: 'confirmed', decided_by_membership_id: MEMBER })
    expect(row!['decided_at']).not.toBeNull()
  })

  it('leaves the queue once it is answered', async () => {
    await confirm(await bookingId())
    expect(await listBookingRequests(run, OP)).toEqual([])
  })

  /** Two people with the same queue open. The second one is told, not ignored. */
  it('refuses a second answer to the same booking', async () => {
    const id = await bookingId()
    await confirm(id)
    expect(await confirm(id, 'declined')).toMatchObject({ decided: false })

    const [row] = await run(`select state::text as state from bookings where id = $1`, [id])
    expect(row!['state']).toBe('confirmed')
  })

  /**
   * They asked and were told no. They have not cancelled anything, and they
   * may well take a different car — so the conversation goes back to open
   * rather than to 'cancelled'.
   */
  it('returns a declined conversation to open', async () => {
    await confirm(await bookingId(), 'declined')
    const [row] = await run(
      `select booking_status::text as status from conversations where id = $1`, [CONV])
    expect(row!['status']).toBe('none')
  })

  it('marks a confirmed conversation confirmed', async () => {
    await confirm(await bookingId())
    const [row] = await run(
      `select booking_status::text as status from conversations where id = $1`, [CONV])
    expect(row!['status']).toBe('confirmed')
  })

  /** Turned down, then they come back for the same car. That is a new yes. */
  it('lets a declined booking be asked for again', async () => {
    const quoteId = await sentQuote()
    const first = await request(quoteId)
    await confirm((first as { booking: { bookingId: string } }).booking.bookingId, 'declined')

    const again = await request(quoteId)
    expect(again).toMatchObject({ ok: true, booking: { alreadyRequested: false } })
  })
})

/**
 * The hole the booking path opened.
 *
 * Confirming wrote nothing to the calendar: `vehicle_availability` had no
 * rows, every availability check answered 'unknown', and the same Ferrari
 * could be quoted, agreed and confirmed twice for the same weekend with
 * nothing anywhere noticing. Latent while nothing could be booked, live the
 * moment bookings were.
 */
describe('a confirmed booking holds the car', () => {
  const confirm = (bookingId: string) =>
    decideBooking(transact, {
      operatorId: OP, bookingId, membershipId: MEMBER, decision: 'confirmed',
    })

  const bookingFor = async (over: Record<string, unknown> = {}) => {
    const result = await request(await sentQuote(over))
    return (result as { booking: { bookingId: string } }).booking.bookingId
  }

  it('blocks the dates on the calendar', async () => {
    await confirm(await bookingFor())

    const [block] = await run(
      `select vehicle_id, start_date, end_date, reason, booking_id, released_at
       from vehicle_availability where operator_id = $1`, [OP])
    expect(block).toMatchObject({
      vehicle_id: CAR,
      start_date: '2026-09-20',
      // Inclusive: a car back on the 21st is not free to somebody else that
      // morning, and over-holding costs a lead where under-holding costs a car.
      end_date: '2026-09-21',
      reason: 'booked',
      released_at: null,
    })
    expect(block!['booking_id']).not.toBeNull()
  })

  /** The disaster this exists to prevent: two people, one car, one weekend. */
  it('refuses a second confirmation for overlapping dates', async () => {
    await confirm(await bookingFor({ revision: 1 }))

    const second = await bookingFor({
      revision: 2, startDate: '2026-09-21', endDate: '2026-09-23',
    })
    const result = await decideBooking(transact, {
      operatorId: OP, bookingId: second, membershipId: MEMBER, decision: 'confirmed',
    })

    expect(result.decided).toBe(false)
    expect(result.conflict).toMatchObject({ startDate: '2026-09-20', endDate: '2026-09-21' })

    // Nothing moved: the customer has not been told anything either way.
    const [row] = await run(`select state::text as state from bookings where id = $1`, [second])
    expect(row!['state']).toBe('requested')
  })

  it('allows a booking that starts after the hold ends', async () => {
    await confirm(await bookingFor({ revision: 1 }))
    const later = await bookingFor({
      revision: 2, startDate: '2026-09-22', endDate: '2026-09-23',
    })
    expect(await confirm(later)).toMatchObject({ decided: true })
  })

  /** Declining must not hold anything — they were told no. */
  it('holds nothing when the answer is no', async () => {
    await decideBooking(transact, {
      operatorId: OP, bookingId: await bookingFor(), membershipId: MEMBER, decision: 'declined',
    })
    expect(await run(`select id from vehicle_availability`, [])).toEqual([])
  })

  it('warns in the queue before anybody presses confirm', async () => {
    await confirm(await bookingFor({ revision: 1 }))
    await bookingFor({ revision: 2, startDate: '2026-09-21', endDate: '2026-09-23' })

    const [waiting] = await listBookingRequests(run, OP)
    expect(waiting!.heldAlready).toMatchObject({
      startDate: '2026-09-20', endDate: '2026-09-21', reason: 'booked',
    })
  })

  /**
   * A block with no way to release it makes a cancelled rental into a car
   * nobody can sell and nobody can explain.
   */
  it('gives the car back when the booking is cancelled', async () => {
    const id = await bookingFor()
    await confirm(id)

    expect(await cancelBooking(transact, {
      operatorId: OP, bookingId: id, membershipId: MEMBER,
    })).toMatchObject({ cancelled: true })

    const [block] = await run(
      `select released_at, released_by from vehicle_availability where booking_id = $1`, [id])
    expect(block!['released_at']).not.toBeNull()
    expect(block!['released_by']).toBe('booking cancelled')

    // And the car is sellable again.
    const next = await bookingFor({ revision: 2 })
    expect(await confirm(next)).toMatchObject({ decided: true })
  })

  it('shows what is on the books, soonest first', async () => {
    await confirm(await bookingFor({ revision: 1, startDate: '2026-09-24', endDate: '2026-09-25' }))
    await confirm(await bookingFor({ revision: 2, startDate: '2026-09-20', endDate: '2026-09-21' }))

    const diary = await listConfirmedBookings(run, OP)
    expect(diary.map((b) => b.startDate)).toEqual(['2026-09-20', '2026-09-24'])
    expect(diary[0]).toMatchObject({ vehicle: 'Ferrari 488 Spider', confirmedBy: 'Ahmed' })
  })

  it('refuses to cancel something that was never confirmed', async () => {
    expect(await cancelBooking(transact, {
      operatorId: OP, bookingId: await bookingFor(), membershipId: MEMBER,
    })).toMatchObject({ cancelled: false })
  })
})

/**
 * The agent answering a yes it can prove.
 *
 * Section 18.8 put final booking confirmation with refunds and payment
 * verification as work that is not an AI tool, and that held for as long as
 * confirming meant asserting a car was free on a calendar nobody maintained.
 * With a real hold and a real overlap test, an operator can decide otherwise —
 * so this is theirs to switch on, and every condition below is a way of saying
 * "and nothing about this is unusual".
 */
describe('confirming without asking anybody', () => {
  const allow = (over: Record<string, unknown> = {}) =>
    run(
      `update operators set auto_confirm_bookings = true,
         availability_calendar_complete = coalesce($2, true),
         auto_confirm_limit_minor = $1
       where id = $3`,
      [over['limit'] ?? null, over['calendar'] ?? null, OP],
    )

  it('does nothing unless the operator has switched it on', async () => {
    const result = await request(await sentQuote())
    expect(result).toMatchObject({ ok: true, booking: { confirmed: false } })
    expect(await run(`select id from vehicle_availability`, [])).toEqual([])
  })

  it('confirms and holds the car in one go', async () => {
    await allow()
    const result = await request(await sentQuote())

    expect(result).toMatchObject({ ok: true, booking: { confirmed: true } })
    const [row] = await run(
      `select state::text as state, decided_automatically, decided_by_membership_id
       from bookings where operator_id = $1`, [OP])
    expect(row).toMatchObject({
      state: 'confirmed',
      decided_automatically: true,
      // Nobody answered it, and the record says so rather than implying it.
      decided_by_membership_id: null,
    })

    const [block] = await run(
      `select reason, recorded_by, start_date from vehicle_availability`, [])
    expect(block).toMatchObject({ recorded_by: 'confirmed by the agent', start_date: '2026-09-20' })
  })

  /**
   * Without a calendar the operator vouches for, "no block" means "nobody
   * knows", and confirming on that is the double booking this system spent a
   * day learning to prevent.
   */
  it('refuses to confirm while the calendar is not vouched for', async () => {
    await allow({ calendar: false })
    expect(await request(await sentQuote())).toMatchObject({ booking: { confirmed: false } })
  })

  it('leaves the car alone when it is already held', async () => {
    await allow()
    await request(await sentQuote({ revision: 1 }))

    const second = await request(await sentQuote({
      revision: 2, startDate: '2026-09-21', endDate: '2026-09-22',
    }))
    expect(second).toMatchObject({ booking: { confirmed: false } })

    const held = await run(`select id from vehicle_availability where released_at is null`, [])
    expect(held).toHaveLength(1)
  })

  /** The unusual booking is the one worth a person's eyes. */
  it('sends a big one to a person', async () => {
    await allow({ limit: 100000 })
    expect(await request(await sentQuote())).toMatchObject({ booking: { confirmed: false } })
  })

  it('leaves it alone when a person already holds the conversation', async () => {
    await allow()
    await run(`update conversations set handler_mode = 'human' where id = $1`, [CONV])
    expect(await request(await sentQuote())).toMatchObject({ booking: { confirmed: false } })
  })

  it('leaves it alone while a handoff is open', async () => {
    await allow()
    await run(
      `insert into handoffs (operator_id, conversation_id, reason, summary, state, due_at)
       values ($1, $2, 'customer_asked', 'wants a person', 'waiting', now() + interval '30 min')`,
      [OP, CONV],
    )
    expect(await request(await sentQuote())).toMatchObject({ booking: { confirmed: false } })
  })

  /** An automatic confirmation is still a confirmation: it can be given back. */
  it('can be cancelled like any other', async () => {
    await allow()
    const result = await request(await sentQuote())
    const id = (result as { booking: { bookingId: string } }).booking.bookingId

    expect(await cancelBooking(transact, {
      operatorId: OP, bookingId: id, membershipId: MEMBER,
    })).toMatchObject({ cancelled: true })
    const [block] = await run(`select released_at from vehicle_availability`, [])
    expect(block!['released_at']).not.toBeNull()
  })
})

/**
 * What a confirmed booking has to stop, and what it has to start.
 *
 * All three of these were live at once in a single exchange: a customer booked
 * a Ferrari, was offered two buttons asking whether to confirm the thing that
 * had just been confirmed, and six minutes later got "Still thinking it over?"
 */
describe('everything downstream of a confirmation', () => {
  const scheduleChase = () =>
    run(
      `insert into follow_ups (operator_id, conversation_id, attempt, reason, state, due_at)
       values ($1, $2, 1, 'no_reply', 'scheduled', now() - interval '1 hour')
       returning id`,
      [OP, CONV],
    )

  const confirm = (bookingId: string) =>
    decideBooking(transact, {
      operatorId: OP, bookingId, membershipId: MEMBER, decision: 'confirmed',
    })

  const bookingFor = async () => {
    const result = await request(await sentQuote())
    return (result as { booking: { bookingId: string } }).booking.bookingId
  }

  it('stops chasing them the moment they say yes', async () => {
    await scheduleChase()
    await request(await sentQuote())

    const [row] = await run(`select state::text as state, cancelled_reason from follow_ups`, [])
    expect(row).toMatchObject({ state: 'cancelled', cancelled_reason: 'they said yes' })
  })

  /**
   * Live: a booked Ferrari still read "Waiting on you: approve or reject a
   * draft quote" on the dashboard.
   */
  it('clears what the dashboard said was waiting', async () => {
    await run(
      `update conversations set next_action = 'Waiting on you: approve or reject a draft quote'
       where id = $1`, [CONV])
    await confirm(await bookingFor())
    const [row] = await run(`select next_action from conversations where id = $1`, [CONV])
    expect(row!['next_action']).toBeNull()
  })

  /** "Approve and send" on it would send a quote to somebody already holding the car. */
  it('takes a booked draft out of the approval queue', async () => {
    const quoteId = await sentQuote()
    await run(`update quotes set state = 'draft' where id = $1`, [quoteId])
    expect(await listDraftQuotes(run, OP)).toHaveLength(1)

    await request(quoteId)
    expect(await listDraftQuotes(run, OP)).toEqual([])
  })

  it('marks the lead won, which nothing ever did', async () => {
    await confirm(await bookingFor())
    const [row] = await run(
      `select sales_stage::text as stage from conversations where id = $1`, [CONV])
    expect(row!['stage']).toBe('won')
  })

  it('records who won it, or that nobody did', async () => {
    await confirm(await bookingFor())
    const [event] = await run(
      `select actor_type::text as actor, actor_id from audit_events where action = 'lead.won'`, [])
    expect(event).toMatchObject({ actor: 'user', actor_id: MEMBER })
  })

  it('does not talk a person out of a lead they already closed', async () => {
    await run(`update conversations set sales_stage = 'lost' where id = $1`, [CONV])
    await confirm(await bookingFor())
    const [row] = await run(
      `select sales_stage::text as stage from conversations where id = $1`, [CONV])
    expect(row!['stage']).toBe('lost')
  })
})

/**
 * Three bookings for one Ferrari on one weekend.
 *
 * Read live. A turn confirmed a booking and timed out before replying, so the
 * customer never heard and asked again. The agent re-quoted — a new quote id,
 * a new revision — and made a second booking against it. Then a third. One of
 * the three was already holding the car.
 *
 * The unique index is per quote, which catches the same yes arriving twice
 * and nothing else. The question a person would ask is not "is this quote
 * already agreed" but "do they already have this car for these days".
 */
describe('a rental they already have', () => {
  const quoteFor = async (revision: number) => sentQuote({ revision })

  it('hands back the booking they already have rather than making another', async () => {
    const first = await request(await quoteFor(1))
    const again = await request(await quoteFor(2))

    expect(again).toMatchObject({ ok: true, booking: { alreadyRequested: true } })
    expect((again as { booking: { bookingId: string } }).booking.bookingId)
      .toBe((first as { booking: { bookingId: string } }).booking.bookingId)
    expect(await run(`select id from bookings where operator_id = $1`, [OP])).toHaveLength(1)
  })

  /** And says it is confirmed, which is what the customer needs to hear. */
  it('says so when the one they have is already confirmed', async () => {
    const first = await request(await quoteFor(1))
    await decideBooking(transact, {
      operatorId: OP,
      bookingId: (first as { booking: { bookingId: string } }).booking.bookingId,
      membershipId: MEMBER,
      decision: 'confirmed',
    })

    expect(await request(await quoteFor(2)))
      .toMatchObject({ ok: true, booking: { alreadyRequested: true, confirmed: true } })
  })

  /** A different car in the same thread is a second rental, not a duplicate. */
  it('still opens one for a different car', async () => {
    await request(await quoteFor(1))

    const [other] = await run(
      `insert into vehicles (operator_id, make, model, year, colour, category, plate,
                             chassis_number, provenance, confirmed_by)
       values ($1,'Rolls-Royce','Cullinan',2023,'White','suv','D 7','V7',
               'operator_confirmed','Owner') returning id`, [OP])
    const quoteId = await sentQuote({ revision: 2, vehicleId: other!['id'] })

    expect(await request(quoteId)).toMatchObject({ ok: true, booking: { alreadyRequested: false } })
    expect(await run(`select id from bookings where operator_id = $1`, [OP])).toHaveLength(2)
  })

  /** And different dates for the same car is a second rental too. */
  it('still opens one for different dates', async () => {
    await request(await quoteFor(1))
    const later = await sentQuote({ revision: 2, startDate: '2026-10-10', endDate: '2026-10-12' })

    expect(await request(later)).toMatchObject({ ok: true, booking: { alreadyRequested: false } })
  })
})

describe('what is on file for this conversation', () => {
  it('lists the live ones, and knows a cancelled one existed', async () => {
    const result = await request(await sentQuote())
    const id = (result as { booking: { bookingId: string } }).booking.bookingId
    expect(await bookingsOnFile(run, { operatorId: OP, conversationId: CONV }))
      .toMatchObject({ live: [{ state: 'requested', startDate: '2026-09-20' }], everHadOne: true })

    await run(`update bookings set state = 'cancelled' where id = $1`, [id])
    expect(await bookingsOnFile(run, { operatorId: OP, conversationId: CONV }))
      .toEqual({ live: [], everHadOne: true })
  })

  it('is empty and unremarkable for a conversation that never booked', async () => {
    expect(await bookingsOnFile(run, { operatorId: OP, conversationId: CONV }))
      .toEqual({ live: [], everHadOne: false })
  })
})

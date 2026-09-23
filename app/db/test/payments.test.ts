import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { beforeEach, describe, expect, it } from 'vitest'
import { decideBooking, requestBooking } from '../src/queries/bookings.ts'
import { extendBooking } from '../src/queries/extensions.ts'
import {
  attachLinkToAllDue, attachPaymentLink, listOutstanding, recordAllDue, recordPayment,
  refundPayment, whatIsOwed,
} from '../src/queries/payments.ts'
import type { QueryRunner, Transactor } from '../src/runner.ts'

/**
 * `bookings` had no payment state at all: a car could be confirmed, held and
 * handed over with nothing recording whether a dirham had moved. The deposit
 * was the sharper half — it flows from the rate into the quote and onto the
 * screen, is quoted to customers, and had never been taken or given back by
 * anything in this product.
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

const inDays = (days: number) =>
  new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10)

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
    insert into operators (id, name, availability_calendar_complete)
    values ('${OP}', 'Vyra Pilot', true);
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
    insert into vehicle_rates (operator_id, vehicle_id, currency, daily_rate_minor,
                               minimum_days, deposit_minor, provenance, confirmed_by, confirmed_at)
    values ('${OP}', '${CAR}', 'AED', 500000, 1, 300000, 'operator_confirmed', 'Owner', now());
  `)
  const [e] = await run(
    `insert into enquiries (operator_id, conversation_id) values ($1,$2) returning id`, [OP, CONV])
  enquiryId = e!['id'] as string
})

/** The figures the customer agreed to, with a deposit on them. */
const sentQuote = async (over: Record<string, unknown> = {}) => {
  const [q] = await run(
    `insert into quotes (operator_id, conversation_id, enquiry_id, vehicle_id, revision, state,
                         total_minor, deposit_minor, lines, start_date, end_date, days,
                         valid_until, approved_by_membership_id, approved_at)
     values ($1,$2,$3,$4,coalesce($5,1),'sent',1000000,$6,'[]'::jsonb,
             $7::timestamptz,$8::timestamptz,2, now() + interval '5 days', $9, now())
     returning id`,
    [
      OP, CONV, enquiryId, CAR, over['revision'] ?? null,
      over['deposit'] === undefined ? 300000 : over['deposit'],
      over['start'] ?? inDays(3), over['end'] ?? inDays(5), MEMBER,
    ],
  )
  return q!['id'] as string
}

const confirmedBooking = async (over: Record<string, unknown> = {}) => {
  const result = await requestBooking(transact, {
    operatorId: OP, conversationId: CONV, enquiryId, quoteId: await sentQuote(over),
  })
  const id = (result as { booking: { bookingId: string } }).booking.bookingId
  await decideBooking(transact, {
    operatorId: OP, bookingId: id, membershipId: MEMBER, decision: 'confirmed',
  })
  return id
}

describe('what a confirmed booking owes', () => {
  it('raises the rental and the deposit from the quote', async () => {
    const owed = await whatIsOwed(run, { operatorId: OP, bookingId: await confirmedBooking() })
    expect(owed.map((o) => [o.kind, o.amountMinor, o.state]))
      .toEqual([['rental', 1000000, 'due'], ['deposit', 300000, 'due']])
  })

  /** Most operators have set no deposit, and inventing one is the whole sin. */
  it('raises no deposit when the operator has not set one', async () => {
    const owed = await whatIsOwed(run, {
      operatorId: OP, bookingId: await confirmedBooking({ deposit: null }),
    })
    expect(owed.map((o) => o.kind)).toEqual(['rental'])
  })

  it('owes nothing until somebody confirms it', async () => {
    const result = await requestBooking(transact, {
      operatorId: OP, conversationId: CONV, enquiryId, quoteId: await sentQuote(),
    })
    const id = (result as { booking: { bookingId: string } }).booking.bookingId
    expect(await whatIsOwed(run, { operatorId: OP, bookingId: id })).toEqual([])
  })

  /** Confirming twice, or a sweep running twice, must not ask twice. */
  it('does not ask for the same thing twice', async () => {
    const id = await confirmedBooking()
    await decideBooking(transact, {
      operatorId: OP, bookingId: id, membershipId: MEMBER, decision: 'confirmed',
    })
    expect(await whatIsOwed(run, { operatorId: OP, bookingId: id })).toHaveLength(2)
  })
})

describe('taking it', () => {
  const rentalOf = async (bookingId: string) =>
    (await whatIsOwed(run, { operatorId: OP, bookingId })).find((o) => o.kind === 'rental')!

  it('records how it arrived and who says so', async () => {
    const rental = await rentalOf(await confirmedBooking())
    expect(await recordPayment(run, {
      operatorId: OP, paymentId: rental.paymentId, membershipId: MEMBER,
      method: 'bank_transfer', reference: 'TRF-8812',
    })).toEqual({ recorded: true })

    const [row] = await run(
      `select state::text as state, method::text as method, paid_at,
              recorded_by_membership_id, reference from payments where id = $1`,
      [rental.paymentId])
    expect(row).toMatchObject({
      state: 'paid', method: 'bank_transfer',
      recorded_by_membership_id: MEMBER, reference: 'TRF-8812',
    })
    expect(row!['paid_at']).not.toBeNull()
  })

  it('will not take the same one twice', async () => {
    const rental = await rentalOf(await confirmedBooking())
    const once = { operatorId: OP, paymentId: rental.paymentId, membershipId: MEMBER,
      method: 'cash' as const }
    expect(await recordPayment(run, once)).toEqual({ recorded: true })
    expect(await recordPayment(run, once)).toEqual({ recorded: false })
  })

  /**
   * No provider is wired, so the link is whatever the operator already uses.
   * The column exists so that wiring one later writes to these rows rather
   * than beside them.
   */
  it('carries a link from whatever the operator already uses', async () => {
    const bookingId = await confirmedBooking()
    const rental = await rentalOf(bookingId)

    expect(await attachPaymentLink(run, {
      operatorId: OP, paymentId: rental.paymentId, linkUrl: 'https://pay.example.com/abc',
    })).toEqual({ attached: true, conversationId: CONV })

    expect((await rentalOf(bookingId)).linkUrl).toBe('https://pay.example.com/abc')
  })

  /** A link against money already taken is a link somebody could still pay. */
  it('will not attach a link to something already paid', async () => {
    const bookingId = await confirmedBooking()
    const rental = await rentalOf(bookingId)
    await recordPayment(run, {
      operatorId: OP, paymentId: rental.paymentId, membershipId: MEMBER, method: 'cash',
    })

    expect(await attachPaymentLink(run, {
      operatorId: OP, paymentId: rental.paymentId, linkUrl: 'https://pay.example.com/abc',
    })).toEqual({ attached: false, conversationId: null })
  })
})

/**
 * One transfer for the rental and the deposit, which is how most customers
 * pay — recorded as one, rather than the same bank credit entered twice.
 */
describe('taking the whole booking at once', () => {
  it('takes every line still owed, with one method and reference', async () => {
    const bookingId = await confirmedBooking()
    expect(await recordAllDue(run, {
      operatorId: OP, bookingId, membershipId: MEMBER, method: 'bank_transfer', reference: 'TRF-1',
    })).toEqual({ recorded: 2 })

    const owed = await whatIsOwed(run, { operatorId: OP, bookingId })
    expect(owed.map((o) => [o.kind, o.state, o.method, o.reference])).toEqual([
      ['rental', 'paid', 'bank_transfer', 'TRF-1'],
      ['deposit', 'paid', 'bank_transfer', 'TRF-1'],
    ])
  })

  it('leaves a line already taken as it was', async () => {
    const bookingId = await confirmedBooking()
    const [rental] = await whatIsOwed(run, { operatorId: OP, bookingId })
    await recordPayment(run, {
      operatorId: OP, paymentId: rental!.paymentId, membershipId: MEMBER, method: 'cash',
    })

    expect(await recordAllDue(run, {
      operatorId: OP, bookingId, membershipId: MEMBER, method: 'bank_transfer',
    })).toEqual({ recorded: 1 })
    expect((await whatIsOwed(run, { operatorId: OP, bookingId }))[0]!.method).toBe('cash')
  })

  it('puts one link on everything still owed', async () => {
    const bookingId = await confirmedBooking()
    expect(await attachLinkToAllDue(run, {
      operatorId: OP, bookingId, linkUrl: 'https://pay.example.com/all',
    })).toEqual({ attached: 2, conversationId: CONV })
    expect((await whatIsOwed(run, { operatorId: OP, bookingId })).map((o) => o.linkUrl))
      .toEqual(['https://pay.example.com/all', 'https://pay.example.com/all'])
  })
})

describe('giving the deposit back', () => {
  const depositOf = async (bookingId: string) =>
    (await whatIsOwed(run, { operatorId: OP, bookingId })).find((o) => o.kind === 'deposit')!

  it('can be refunded once it was taken', async () => {
    const deposit = await depositOf(await confirmedBooking())
    await recordPayment(run, {
      operatorId: OP, paymentId: deposit.paymentId, membershipId: MEMBER, method: 'card_in_person',
    })
    expect(await refundPayment(run, {
      operatorId: OP, paymentId: deposit.paymentId, membershipId: MEMBER,
    })).toEqual({ refunded: true })
  })

  /** "Refunded" against money that never arrived is a story, not a record. */
  it('cannot be refunded when it was never taken', async () => {
    const deposit = await depositOf(await confirmedBooking())
    expect(await refundPayment(run, {
      operatorId: OP, paymentId: deposit.paymentId, membershipId: MEMBER,
    })).toEqual({ refunded: false })
  })
})

describe('what is still owed', () => {
  it('lists it with the car leaving soonest first', async () => {
    await confirmedBooking()
    const outstanding = await listOutstanding(run, OP)
    expect(outstanding.map((o) => o.kind)).toEqual(['rental', 'deposit'])
    expect(outstanding[0]).toMatchObject({ vehicle: 'Ferrari 488 Spider', customer: '9715001' })
  })

  it('drops off once it is taken', async () => {
    const id = await confirmedBooking()
    for (const owed of await whatIsOwed(run, { operatorId: OP, bookingId: id })) {
      await recordPayment(run, {
        operatorId: OP, paymentId: owed.paymentId, membershipId: MEMBER, method: 'cash',
      })
    }
    expect(await listOutstanding(run, OP)).toEqual([])
  })
})

/**
 * They already have the car and the deposit held against it. Raising a second
 * one would ask them to pay a deposit twice for the same rental.
 */
describe('extending a rental', () => {
  it('owes the extra days and no second deposit', async () => {
    const id = await confirmedBooking()
    const result = await extendBooking(transact, {
      operatorId: OP, bookingId: id, newEndDate: inDays(7), membershipId: MEMBER,
    })
    const extensionId = (result as { extension: { bookingId: string } }).extension.bookingId

    const owed = await whatIsOwed(run, { operatorId: OP, bookingId: extensionId })
    expect(owed.map((o) => o.kind)).toEqual(['rental'])
  })
})

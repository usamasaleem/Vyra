import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  activeBookingFor, bookingChecklist, fileBookingDocument, markDocumentsChecked,
  recordBookingProgress, fileWaitingDocuments,
} from '../src/queries/booking-checklist.ts'
import { decideBooking, requestBooking } from '../src/queries/bookings.ts'
import type { QueryRunner, Transactor } from '../src/runner.ts'

/**
 * The agent stopped at "Booked", and everything that turns a booking into a
 * car at somebody's door — where, when, the documents, the money — fell to a
 * salesperson messaging the customer again.
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

const inDays = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString().slice(0, 10)

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
    insert into operators (id, name, availability_calendar_complete) values ('${OP}', 'Vyra Pilot', true);
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

const confirmed = async (preference: 'delivery' | 'collection' | null = 'delivery') => {
  if (preference !== null) {
    await run(
      `insert into field_evidence (operator_id, enquiry_id, field, value)
       values ($1, $2, 'delivery_preference', $3)`, [OP, enquiryId, preference])
  }
  const [q] = await run(
    `insert into quotes (operator_id, conversation_id, enquiry_id, vehicle_id, revision, state,
                         total_minor, deposit_minor, lines, start_date, end_date, days,
                         valid_until, approved_by_membership_id, approved_at)
     values ($1,$2,$3,$4,1,'sent',1000000,500000,'[]'::jsonb,$5::timestamptz,$6::timestamptz,2,
             now() + interval '5 days',$7,now()) returning id`,
    [OP, CONV, enquiryId, CAR, inDays(3), inDays(5), MEMBER])
  const r = await requestBooking(transact, {
    operatorId: OP, conversationId: CONV, enquiryId, quoteId: q!['id'] as string,
  })
  const id = (r as { booking: { bookingId: string } }).booking.bookingId
  await decideBooking(transact, { operatorId: OP, bookingId: id, membershipId: MEMBER, decision: 'confirmed' })
  return id
}

const photo = async () => {
  const [m] = await run(
    `insert into messages (operator_id, conversation_id, direction, kind, provider_id)
     values ($1,$2,'inbound','image',$3) returning id`, [OP, CONV, `wamid.${Math.random()}`])
  return m!['id'] as string
}

describe('what a confirmed booking still needs', () => {
  it('starts with everything missing, in the order worth asking', async () => {
    const list = await bookingChecklist(run, { operatorId: OP, bookingId: await confirmed() })
    expect(list!.missing).toEqual(['delivery_address', 'delivery_time', 'documents', 'payment'])
  })

  /**
   * A customer collecting has no address to give, but still has a time.
   * Live: "collection it is", "Confirmed", and nobody learned when they were
   * coming for the car.
   */
  it('asks a collecting customer when, not where', async () => {
    const list = await bookingChecklist(run, { operatorId: OP, bookingId: await confirmed('collection') })
    expect(list!.missing).toEqual(['collection_time', 'documents', 'payment'])
  })

  /**
   * Live: never asked, told "What time will you collect the Ferrari?", then
   * chose delivery on the next message.
   */
  it('asks delivery or collection before any time, when nobody has said', async () => {
    const list = await bookingChecklist(run, { operatorId: OP, bookingId: await confirmed(null) })
    expect(list!.missing).toEqual(['handover_choice', 'documents', 'payment'])
  })

  it('stops asking a collecting customer once they give the time', async () => {
    const id = await confirmed('collection')
    await recordBookingProgress(run, { operatorId: OP, bookingId: id, deliveryTime: '11:00' })
    expect((await bookingChecklist(run, { operatorId: OP, bookingId: id }))!.missing)
      .toEqual(['documents', 'payment'])
  })

  it('is done once they have told it everything', async () => {
    const id = await confirmed()
    await recordBookingProgress(run, {
      operatorId: OP, bookingId: id,
      deliveryAddress: 'Marina Gate 2, Apt 1904', deliveryTime: '10:00',
      paymentPlan: 'transfer', saysPaid: true,
    })
    await fileBookingDocument(run, { operatorId: OP, bookingId: id, conversationId: CONV, messageId: await photo() })
    await fileBookingDocument(run, { operatorId: OP, bookingId: id, conversationId: CONV, messageId: await photo() })

    expect((await bookingChecklist(run, { operatorId: OP, bookingId: id }))!.missing).toEqual([])
  })

  /** Paying the driver is an answer; nothing is owed before the car arrives. */
  it('counts paying on delivery as settled from their side', async () => {
    const id = await confirmed('collection')
    await recordBookingProgress(run, { operatorId: OP, bookingId: id, paymentPlan: 'on_delivery' })
    expect((await bookingChecklist(run, { operatorId: OP, bookingId: id }))!.missing)
      .toEqual(['collection_time', 'documents'])
  })

  /** Choosing to transfer is not the same as having transferred. */
  it('still wants payment until they say they have paid', async () => {
    const id = await confirmed('collection')
    await recordBookingProgress(run, { operatorId: OP, bookingId: id, paymentPlan: 'transfer' })
    expect((await bookingChecklist(run, { operatorId: OP, bookingId: id }))!.missing).toContain('payment')
  })
})

describe('recording what they said', () => {
  /** A turn that learns the time must not wipe the address from the last one. */
  it('fills gaps without erasing what is there', async () => {
    const id = await confirmed()
    await recordBookingProgress(run, { operatorId: OP, bookingId: id, deliveryAddress: 'Marina Gate 2' })
    await recordBookingProgress(run, { operatorId: OP, bookingId: id, deliveryTime: '14:30' })
    const list = await bookingChecklist(run, { operatorId: OP, bookingId: id })
    expect(list).toMatchObject({ deliveryAddress: 'Marina Gate 2', deliveryTime: '14:30' })
  })

  it('refuses a time that is not a time', async () => {
    const id = await confirmed()
    await expect(recordBookingProgress(run, { operatorId: OP, bookingId: id, deliveryTime: 'morning' }))
      .rejects.toThrow()
  })
})

describe('the photos', () => {
  it('files each once however often the job runs', async () => {
    const id = await confirmed()
    const m = await photo()
    await fileBookingDocument(run, { operatorId: OP, bookingId: id, conversationId: CONV, messageId: m })
    expect(await fileBookingDocument(run, { operatorId: OP, bookingId: id, conversationId: CONV, messageId: m }))
      .toMatchObject({ total: 1 })
  })

  it('carries the name of whoever checked them', async () => {
    const id = await confirmed()
    expect(await markDocumentsChecked(run, { operatorId: OP, bookingId: id, membershipId: MEMBER }))
      .toEqual({ checked: true })
    const [row] = await run(`select documents_checked_by_membership_id from bookings where id = $1`, [id])
    expect(row!['documents_checked_by_membership_id']).toBe(MEMBER)
  })
})

describe('which booking the conversation is working on', () => {
  it('is the confirmed one still to happen', async () => {
    const id = await confirmed()
    expect(await activeBookingFor(run, { operatorId: OP, conversationId: CONV })).toBe(id)
  })

  it('is nothing when they have none', async () => {
    expect(await activeBookingFor(run, { operatorId: OP, conversationId: CONV })).toBeNull()
  })
})

/**
 * Live: a licence and an Emirates ID arrived 0.7s apart, the older one's job
 * gave way to the newer, and the booking held one of them.
 */
describe('photos that arrive together', () => {
  it('files every photo sent since the booking, not only the newest', async () => {
    const id = await confirmed()
    await photo()
    await photo()
    expect(await fileWaitingDocuments(run, { operatorId: OP, bookingId: id, conversationId: CONV }))
      .toEqual({ filed: 2, total: 2 })
    expect((await bookingChecklist(run, { operatorId: OP, bookingId: id }))!.missing)
      .not.toContain('documents')
  })

  it('files each one once', async () => {
    const id = await confirmed()
    await photo()
    await fileWaitingDocuments(run, { operatorId: OP, bookingId: id, conversationId: CONV })
    expect(await fileWaitingDocuments(run, { operatorId: OP, bookingId: id, conversationId: CONV }))
      .toEqual({ filed: 0, total: 1 })
  })

  it('leaves photos from before the booking alone', async () => {
    await photo()
    await run(`update messages set created_at = now() - interval '1 day' where kind = 'image'`)
    const id = await confirmed()
    expect(await fileWaitingDocuments(run, { operatorId: OP, bookingId: id, conversationId: CONV }))
      .toEqual({ filed: 0, total: 0 })
  })
})

describe('changing between delivery and collection', () => {
  it('drops a time given for the other one', async () => {
    const id = await confirmed('collection')
    await recordBookingProgress(run, { operatorId: OP, bookingId: id, deliveryTime: '16:00' })
    await recordBookingProgress(run, { operatorId: OP, bookingId: id, clearTime: true })
    expect((await bookingChecklist(run, { operatorId: OP, bookingId: id }))!.deliveryTime).toBeNull()
  })
})

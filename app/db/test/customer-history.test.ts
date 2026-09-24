import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { beforeEach, describe, expect, it } from 'vitest'
import { bookingChecklist } from '../src/queries/booking-checklist.ts'
import { customerHistory } from '../src/queries/customer-history.ts'
import type { QueryRunner } from '../src/runner.ts'

/**
 * Somebody who has rented before is not a stranger: not asked for the licence
 * a colleague checked last month, not asked where they are from again.
 */
const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations')
const OP = '11111111-1111-1111-1111-111111111111'
const ACCOUNT = '33333333-3333-3333-3333-333333333333'
const CAR = '44444444-4444-4444-4444-444444444444'
const CONTACT = '55555555-5555-5555-5555-555555555555'
const CONV = '66666666-6666-6666-6666-666666666666'
const MEMBER = '88888888-8888-8888-8888-888888888888'

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
    insert into memberships (id, operator_id, user_id, role, display_name)
    values ('${MEMBER}', '${OP}', '99999999-9999-9999-9999-999999999999', 'admin', 'Usama');
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
})

/** A confirmed rental from `start` for two days; `checked` puts a name on its documents. */
const rental = async (start: string, options: { checked?: boolean; address?: string; residency?: string } = {}) => {
  const [e] = await run(`insert into enquiries (operator_id, conversation_id) values ($1, $2) returning id`, [OP, CONV])
  if (options.residency !== undefined) {
    await run(`insert into field_evidence (operator_id, enquiry_id, field, value) values ($1, $2, 'residency', $3)`,
      [OP, e!['id'], options.residency])
  }
  await run(`insert into field_evidence (operator_id, enquiry_id, field, value) values ($1, $2, 'delivery_preference', 'delivery')`,
    [OP, e!['id']])
  const [q] = await run(
    `insert into quotes (operator_id, conversation_id, enquiry_id, vehicle_id, revision, state, total_minor,
                         lines, start_date, end_date, days, valid_until)
     values ($1, $2, $3, $4, (select coalesce(max(revision), 0) + 1 from quotes), 'superseded', 1000000,
             '[]'::jsonb, $5::date, $5::date + 2, 2, now() + interval '1 day') returning id`,
    [OP, CONV, e!['id'], CAR, start])
  const [b] = await run(
    `insert into bookings (operator_id, conversation_id, enquiry_id, quote_id, state, decided_at,
                           decided_automatically, delivery_address, documents_checked_at,
                           documents_checked_by_membership_id)
     values ($1, $2, $3, $4, 'confirmed', now(), true, $5, $6, $7) returning id`,
    [OP, CONV, e!['id'], q!['id'], options.address ?? null,
      options.checked === true ? new Date().toISOString() : null, options.checked === true ? MEMBER : null])
  return b!['id'] as string
}

describe('a customer who has rented before', () => {
  it('is remembered: what they had, where it went, where they live', async () => {
    await rental('2026-01-10', { checked: true, address: 'Marina Gate 2, Apt 1904', residency: 'UAE resident' })
    const history = await customerHistory(run, { operatorId: OP, contactId: CONTACT })
    expect(history.rentals).toEqual([{
      vehicle: 'Ferrari 488 Spider', startDate: '2026-01-10', handover: 'delivery',
      deliveryAddress: 'Marina Gate 2, Apt 1904',
    }])
    expect(history.residency).toBe('UAE resident')
    expect(history.documentsCheckedAt).not.toBeNull()
  })

  it('is not asked for documents a person checked within the year', async () => {
    await rental('2026-01-10', { checked: true })
    const next = await rental('2099-03-01')
    const list = await bookingChecklist(run, { operatorId: OP, bookingId: next })
    expect(list!.missing).not.toContain('documents')
    expect(list!.documentsOnFileFrom).not.toBeNull()
  })

  it('is asked again when nobody checked them last time', async () => {
    await rental('2026-01-10')
    const next = await rental('2099-03-01')
    expect((await bookingChecklist(run, { operatorId: OP, bookingId: next }))!.missing).toContain('documents')
  })

  it('does not count a rental that has not happened yet', async () => {
    await rental('2099-03-01')
    expect((await customerHistory(run, { operatorId: OP, contactId: CONTACT })).rentals).toEqual([])
  })
})

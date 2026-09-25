import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { documentChecker } from '../src/document-check.ts'
import type { ReadDocument } from '../../contracts/src/document-check.ts'
import type { QueryRunner } from '../../db/src/runner.ts'
import type { WhatsAppClient } from '../src/whatsapp/client.ts'

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

const MEMBER = '88888888-8888-8888-8888-888888888888'
const booked = async () => {
  await db.exec(`
    insert into memberships (id, operator_id, user_id, role) values ('${MEMBER}', '${OP}', '99999999-9999-9999-9999-999999999999', 'admin');
    insert into vehicles (id, operator_id, make, model, year, colour, category, plate, chassis_number, provenance, confirmed_by)
    values ('44444444-4444-4444-4444-444444444444', '${OP}', 'Ferrari', '488', 2022, 'Giallo', 'exotic', 'D 9', 'V9', 'operator_confirmed', 'Owner');
  `)
  const [e] = await run(`insert into enquiries (operator_id, conversation_id) values ($1, $2) returning id`, [OP, CONV])
  const [q] = await run(
    `insert into quotes (operator_id, conversation_id, enquiry_id, vehicle_id, revision, state, total_minor, lines,
                         start_date, end_date, days, approved_by_membership_id, approved_at)
     values ($1, $2, $3, '44444444-4444-4444-4444-444444444444', 1, 'sent', 1000000, '[]'::jsonb,
             '2026-09-26', '2026-09-28', 2, $4, now()) returning id`, [OP, CONV, e!['id'], MEMBER])
  const [b] = await run(
    `insert into bookings (operator_id, conversation_id, enquiry_id, quote_id, state, decided_at)
     values ($1, $2, $3, $4, 'confirmed', now()) returning id`, [OP, CONV, e!['id'], q!['id']])
  for (const mediaId of ['LIC', 'PASS']) {
    const [m] = await run(
      `insert into messages (operator_id, conversation_id, direction, kind, provider_id, media)
       values ($1, $2, 'inbound', 'image', $3, $4::jsonb) returning id`,
      [OP, CONV, `wamid.${mediaId}`, JSON.stringify({ type: 'image', mediaId })])
    await run(`insert into booking_documents (operator_id, booking_id, conversation_id, message_id) values ($1, $2, $3, $4)`,
      [OP, b!['id'], CONV, m!['id']])
  }
  // The operator's own rule sets the age, as it does for the agent.
  const [k] = await run(
    `insert into knowledge_entries (operator_id, topic, covers, answer, version, provenance, confirmed_by,
       confirmed_by_membership_id, confirmed_at, published_at, published_by_membership_id, effective_from)
     values ($1, 'driver-requirements-visitor', 'c', 'Licences from the UK and EU are accepted on their own. The minimum age is 25 and you must have held your licence for at least a year.',
       1, 'operator_confirmed', 'Owner', $2, now(), now(), $2, now() - interval '1 hour') returning id`, [OP, MEMBER])
  void k
  return b!['id'] as string
}

const downloads = () =>
  ({ fetchMedia: vi.fn(async ({ mediaId }: { mediaId: string }) => ({ bytes: new TextEncoder().encode(mediaId) as Uint8Array<ArrayBuffer>, mimeType: 'image/jpeg' })) } as unknown as WhatsAppClient)

const reads = (byMedia: Record<string, ReadDocument>) =>
  async ({ bytes }: { bytes: Uint8Array<ArrayBuffer> }) => byMedia[new TextDecoder().decode(bytes)] ?? null

const LICENCE: ReadDocument = { kind: 'driving_licence', legible: true, country: 'United Kingdom', fullName: 'John Smith',
  dateOfBirth: '1990-03-14', expiryDate: '2031-01-01', issueDate: '2010-01-01' }
const PASSPORT: ReadDocument = { kind: 'passport', legible: true, country: 'United Kingdom', fullName: 'SMITH JOHN',
  dateOfBirth: '1990-03-14', expiryDate: '2030-01-01', issueDate: null }

const log = () => {}

describe('the automatic documents check', () => {
  it('reads both photos, approves, and marks the booking checked by the system', async () => {
    const bookingId = await booked()
    const check = documentChecker({ run, whatsapp: downloads(), reader: reads({ LIC: LICENCE, PASS: PASSPORT }), log })
    expect(await check({ operatorId: OP, bookingId, visitor: true })).toMatchObject({ verdict: 'approved' })
    const [b] = await run(`select documents_checked_automatically as auto, documents_check from bookings where id = $1`, [bookingId])
    expect(b!['auto']).toBe(true)
    expect((b!['documents_check'] as { documents: unknown[] }).documents).toHaveLength(2)
  })

  it('uses the operator’s minimum age', async () => {
    const bookingId = await booked()
    const young = { ...PASSPORT, dateOfBirth: '2003-01-01' }
    const check = documentChecker({ run, whatsapp: downloads(), reader: reads({ LIC: { ...LICENCE, dateOfBirth: '2003-01-01' }, PASS: young }), log })
    const verdict = await check({ operatorId: OP, bookingId, visitor: true })
    expect(verdict).toMatchObject({ verdict: 'problem' })
    expect(verdict!.reasons.join(' ')).toMatch(/minimum is 25/)
  })

  it('gives up quietly when a photo will not download, leaving it to a person', async () => {
    const bookingId = await booked()
    const failing = { fetchMedia: vi.fn(async () => null) } as unknown as WhatsAppClient
    const check = documentChecker({ run, whatsapp: failing, reader: reads({}), log })
    expect(await check({ operatorId: OP, bookingId, visitor: true })).toBeNull()
  })
})

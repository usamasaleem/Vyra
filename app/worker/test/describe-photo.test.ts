import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { describePhoto } from '../src/describe-photo.ts'
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

const photo = async (media: Record<string, unknown> = { type: 'image', mediaId: 'P1' }) => {
  const rows = await run(
    `insert into messages (operator_id, conversation_id, direction, kind, provider_id, media)
     values ($1, $2, 'inbound', 'image', $3, $4::jsonb) returning id`,
    [OP, CONV, `wamid.${Math.random()}`, JSON.stringify(media)],
  )
  return rows[0]!['id'] as string
}

const downloads = () =>
  ({ fetchMedia: vi.fn(async () => ({ bytes: new Uint8Array([1, 2, 3]), mimeType: 'image/jpeg' })) } as unknown as WhatsAppClient)

const row = async (messageId: string) =>
  (await run(`select body, media, kind::text as kind from messages where id = $1`, [messageId]))[0]!

const log = () => {}

describe('a photo, in words', () => {
  it('is described where its text would be, marked as a description, caption kept', async () => {
    const messageId = await photo({ type: 'image', mediaId: 'P1', caption: 'this one?' })
    expect(await describePhoto({
      run, whatsapp: downloads(), reader: async () => 'A green Lamborghini Huracán, from the front.', messageId, log,
    })).toBe(true)
    const r = await row(messageId)
    expect(r['body']).toBe(
      '[Photo from the customer, described automatically: A green Lamborghini Huracán, from the front.]\nTheir caption: "this one?"')
    expect((r['media'] as Record<string, unknown>)['described']).toBe(true)
    // Still a photo: the inbox shows it, and a booking still files it as a document.
    expect(r['kind']).toBe('image')
  })

  it('leaves it for a person when it cannot be read', async () => {
    const messageId = await photo()
    expect(await describePhoto({ run, whatsapp: downloads(), reader: async () => null, messageId, log })).toBe(false)
    expect((await row(messageId))['body']).toBeNull()
  })

  it('leaves it for a person when there is no reader', async () => {
    const messageId = await photo()
    expect(await describePhoto({ run, whatsapp: downloads(), reader: null, messageId, log })).toBe(false)
  })

  it('does not describe it twice', async () => {
    const messageId = await photo()
    await describePhoto({ run, whatsapp: downloads(), reader: async () => 'first', messageId, log })
    expect(await describePhoto({ run, whatsapp: downloads(), reader: async () => 'second', messageId, log })).toBe(false)
    expect((await row(messageId))['body']).toMatch(/first/)
  })
})

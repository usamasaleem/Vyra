import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { transcribeVoiceNote } from '../src/transcribe-voice-note.ts'
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

const voiceNote = async (media: Record<string, unknown> | null = { type: 'audio', mediaId: 'M1' }) => {
  const rows = await run(
    `insert into messages (operator_id, conversation_id, direction, kind, provider_id, media)
     values ($1, $2, 'inbound', 'audio', $3, $4::jsonb) returning id`,
    [OP, CONV, `wamid.${Math.random()}`, media === null ? null : JSON.stringify(media)],
  )
  return rows[0]!['id'] as string
}

const downloads = (bytes = new Uint8Array([1, 2, 3]), mimeType = 'audio/ogg') =>
  ({ fetchMedia: vi.fn(async () => ({ bytes, mimeType })) } as unknown as WhatsAppClient)

const body = async (messageId: string) =>
  (await run(`select body, media from messages where id = $1`, [messageId]))[0]

const log = () => {}

describe('turning a voice note into words', () => {
  it('writes what was said into the message', async () => {
    const messageId = await voiceNote()
    const heard = await transcribeVoiceNote({
      run, whatsapp: downloads(), transcriber: async () => 'Do you have the Cullinan free Friday',
      messageId, log,
    })

    expect(heard).toBe(true)
    expect((await body(messageId))!['body']).toBe('Do you have the Cullinan free Friday')
  })

  /**
   * It stays a voice note. A salesperson reading the thread should see it was
   * spoken, and the model is told so too — "Huracán" and "hurricane" are one
   * bad second apart.
   */
  it('marks it as transcribed rather than typed', async () => {
    const messageId = await voiceNote()
    await transcribeVoiceNote({
      run, whatsapp: downloads(), transcriber: async () => 'hello', messageId, log,
    })

    const row = await body(messageId)
    expect((row!['media'] as Record<string, unknown>)['transcribed']).toBe(true)
    const [kind] = await run(`select kind::text as kind from messages where id = $1`, [messageId])
    expect(kind!['kind']).toBe('audio')
  })

  it('does not overwrite a transcription that already happened', async () => {
    const messageId = await voiceNote()
    await transcribeVoiceNote({
      run, whatsapp: downloads(), transcriber: async () => 'first', messageId, log,
    })
    const second = await transcribeVoiceNote({
      run, whatsapp: downloads(), transcriber: async () => 'second', messageId, log,
    })

    expect(second).toBe(false)
    expect((await body(messageId))!['body']).toBe('first')
  })
})

/**
 * Every failure lands in the same place: the body stays null and the message
 * routes to a person, which is what has always happened to voice notes and
 * works. There is no version of this where a guess beats a handover.
 */
describe('a voice note it cannot read', () => {
  it('leaves it for a person when there is no transcriber', async () => {
    const messageId = await voiceNote()
    expect(await transcribeVoiceNote({
      run, whatsapp: downloads(), transcriber: null, messageId, log,
    })).toBe(false)
    expect((await body(messageId))!['body']).toBeNull()
  })

  /** Every voice note in the pilot's database is a pointer to nothing. */
  it('leaves it for a person when the media id was never stored', async () => {
    const messageId = await voiceNote({ type: 'audio' })
    expect(await transcribeVoiceNote({
      run, whatsapp: downloads(), transcriber: async () => 'hello', messageId, log,
    })).toBe(false)
    expect((await body(messageId))!['body']).toBeNull()
  })

  it('leaves it for a person when the download fails', async () => {
    const messageId = await voiceNote()
    const failing = { fetchMedia: vi.fn(async () => null) } as unknown as WhatsAppClient
    expect(await transcribeVoiceNote({
      run, whatsapp: failing, transcriber: async () => 'hello', messageId, log,
    })).toBe(false)
    expect((await body(messageId))!['body']).toBeNull()
  })

  it('leaves it for a person when nothing could be made out', async () => {
    const messageId = await voiceNote()
    expect(await transcribeVoiceNote({
      run, whatsapp: downloads(), transcriber: async () => null, messageId, log,
    })).toBe(false)
    expect((await body(messageId))!['body']).toBeNull()
  })

  /** A photograph is not a voice note, and this must not touch it. */
  it('ignores anything that is not audio', async () => {
    const rows = await run(
      `insert into messages (operator_id, conversation_id, direction, kind, provider_id, media)
       values ($1, $2, 'inbound', 'image', $3, '{"mediaId":"M1"}'::jsonb) returning id`,
      [OP, CONV, `wamid.${Math.random()}`],
    )
    const messageId = rows[0]!['id'] as string
    expect(await transcribeVoiceNote({
      run, whatsapp: downloads(), transcriber: async () => 'a car', messageId, log,
    })).toBe(false)
  })

  /** Nothing here may rewrite something a customer actually typed. */
  it('never touches a message that already has words', async () => {
    const rows = await run(
      `insert into messages (operator_id, conversation_id, direction, kind, body, provider_id, media)
       values ($1, $2, 'inbound', 'audio', 'typed', $3, '{"mediaId":"M1"}'::jsonb) returning id`,
      [OP, CONV, `wamid.${Math.random()}`],
    )
    const messageId = rows[0]!['id'] as string
    expect(await transcribeVoiceNote({
      run, whatsapp: downloads(), transcriber: async () => 'spoken', messageId, log,
    })).toBe(false)
    expect((await body(messageId))!['body']).toBe('typed')
  })
})

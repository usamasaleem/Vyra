import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { beforeEach, describe, expect, it } from 'vitest'
import { applyMessageStatus, type QueryRunner } from '../src/lib/whatsapp/ingest.ts'

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)),'..','..','db','migrations')
const OPERATOR = '11111111-1111-1111-1111-111111111111'
const PHONE_NUMBER_ID = '100000000000001'
const WAMID = 'wamid.OUTBOUND1'

let db: PGlite
let run: QueryRunner

const stateOf = async () =>
  (await run('select delivery_state from messages where provider_id = $1', [WAMID]))[0]!['delivery_state']

const apply = (status: string, errorCode?: string) =>
  applyMessageStatus(run, { providerMessageId: WAMID, status, phoneNumberId: PHONE_NUMBER_ID, errorCode })

beforeEach(async () => {
  db = await PGlite.create()
  run = async (t, p) => (await db.query(t, p)).rows as Array<Record<string, unknown>>
  for (const f of readdirSync(migrationsDir).filter((n) => n.endsWith('.sql')).sort()) {
    await db.exec(readFileSync(join(migrationsDir, f), 'utf8'))
  }
  await db.exec(`
    insert into operators (id, name) values ('${OPERATOR}', 'Vyra Pilot');
    insert into whatsapp_accounts (id, operator_id, provider_account_id, phone_number_id)
    values ('33333333-3333-3333-3333-333333333333', '${OPERATOR}', 'waba', '${PHONE_NUMBER_ID}');
    insert into contacts (id, operator_id, channel_identifier)
    values ('55555555-5555-5555-5555-555555555555', '${OPERATOR}', '971500000001');
    insert into conversations (id, operator_id, contact_id, whatsapp_account_id)
    values ('66666666-6666-6666-6666-666666666666', '${OPERATOR}',
            '55555555-5555-5555-5555-555555555555', '33333333-3333-3333-3333-333333333333');
    insert into messages (operator_id, conversation_id, direction, kind, body, delivery_state, provider_id)
    values ('${OPERATOR}', '66666666-6666-6666-6666-666666666666', 'outbound', 'text',
            'Here are two options.', 'accepted', '${WAMID}');
  `)
})

describe('applying delivery receipts', () => {
  it('advances accepted through sent, delivered and read', async () => {
    for (const status of ['sent', 'delivered', 'read']) {
      expect((await apply(status)).applied).toBe(true)
      expect(await stateOf()).toBe(status)
    }
  })

  /** Meta's receipts genuinely arrive out of order. */
  it('never moves a message backwards', async () => {
    await apply('read')
    expect(await stateOf()).toBe('read')

    expect((await apply('delivered')).applied).toBe(false)
    expect((await apply('sent')).applied).toBe(false)
    expect(await stateOf()).toBe('read')
  })

  it('is safe to apply the same receipt twice', async () => {
    await apply('delivered')
    expect((await apply('delivered')).applied).toBe(false)
    expect(await stateOf()).toBe('delivered')
  })

  /** A message Meta could not deliver is not delivered, whatever came before. */
  it('lets failure win over any earlier receipt', async () => {
    await apply('read')
    expect((await apply('failed', '131049')).applied).toBe(true)
    expect(await stateOf()).toBe('failed')

    const row = (await run('select error_code from messages where provider_id = $1', [WAMID]))[0]!
    expect(row['error_code']).toBe('131049')
  })

  it('ignores a status it does not recognise', async () => {
    expect(await apply('warp_speed')).toEqual({ applied: false, deliveryState: null })
    expect(await stateOf()).toBe('accepted')
  })

  it('ignores a receipt for an unknown message', async () => {
    const result = await applyMessageStatus(run, {
      providerMessageId: 'wamid.NOT_OURS', status: 'delivered', phoneNumberId: PHONE_NUMBER_ID,
    })
    expect(result.applied).toBe(false)
  })

  it('ignores a receipt arriving on another operator number', async () => {
    const result = await applyMessageStatus(run, {
      providerMessageId: WAMID, status: 'delivered', phoneNumberId: '999999',
    })
    expect(result.applied).toBe(false)
    expect(await stateOf()).toBe('accepted')
  })
})

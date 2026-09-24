import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { beforeEach, describe, expect, it } from 'vitest'
import { sendTeamAlerts, type Push } from '../src/team-alerts.ts'
import { raiseHandoff } from '../../db/src/queries/handoff-queue.ts'
import { savePushSubscription } from '../../db/src/queries/team-alerts.ts'
import type { QueryRunner } from '../../db/src/runner.ts'

/** The sweep end to end, with the push service replaced. */
const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'db', 'migrations')
const OP = '11111111-1111-1111-1111-111111111111'
const ACCOUNT = '33333333-3333-3333-3333-333333333333'
const SARA = '44444444-4444-4444-4444-444444444444'
const CONTACT = '55555555-5555-5555-5555-555555555555'
const CONV = '66666666-6666-6666-6666-666666666666'

let db: PGlite
let run: QueryRunner
const silently = () => {}

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
    insert into memberships (id, operator_id, user_id, role)
    values ('${SARA}', '${OP}', '10000000-0000-0000-0000-000000000001', 'salesperson');
    insert into contacts (id, operator_id, channel_identifier, display_name)
    values ('${CONTACT}', '${OP}', '971500000001', 'Elena');
    insert into conversations (id, operator_id, contact_id, whatsapp_account_id)
    values ('${CONV}', '${OP}', '${CONTACT}', '${ACCOUNT}');
  `)
  for (const endpoint of ['https://push.example/phone', 'https://push.example/old-laptop']) {
    await savePushSubscription(run, { operatorId: OP, membershipId: SARA, endpoint, p256dh: 'k', auth: 'a', userAgent: null })
  }
})

describe('sending team alerts', () => {
  it('sends each alert once, and forgets a device that is gone', async () => {
    const sent: Array<{ endpoint: string; payload: unknown }> = []
    const push: Push = async (device, payload) => {
      if (device.endpoint.endsWith('old-laptop')) return { ok: false, gone: true }
      sent.push({ endpoint: device.endpoint, payload: JSON.parse(payload) })
      return { ok: true, gone: false }
    }
    await raiseHandoff(run, { operatorId: OP, conversationId: CONV, reason: 'customer_asked', summary: 'Wants a call.' })

    expect(await sendTeamAlerts(run, silently, push)).toEqual({ sent: 1, delivered: 1 })
    expect(sent).toEqual([{
      endpoint: 'https://push.example/phone',
      payload: expect.objectContaining({ title: 'Elena needs a person', body: 'Wants a call.', url: `/conversations/${CONV}` }),
    }])
    expect(await run(`select endpoint from push_subscriptions`, [])).toEqual([{ endpoint: 'https://push.example/phone' }])

    // Nothing new: nothing sent.
    expect(await sendTeamAlerts(run, silently, push)).toEqual({ sent: 0, delivered: 0 })
    expect(sent).toHaveLength(1)
  })

  it('records an alert that reached nobody rather than retrying it forever', async () => {
    await run(`delete from push_subscriptions`, [])
    await raiseHandoff(run, { operatorId: OP, conversationId: CONV, reason: 'customer_asked', summary: 'Wants a call.' })
    expect(await sendTeamAlerts(run, silently, async () => ({ ok: true, gone: false }))).toEqual({ sent: 1, delivered: 0 })
    expect(await run(`select delivered, sent_at is not null as sent from team_alerts`, [])).toEqual([{ delivered: 0, sent: true }])
  })
})

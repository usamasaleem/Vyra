import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { beforeEach, describe, expect, it } from 'vitest'
import { raiseHandoff } from '../src/queries/handoff-queue.ts'
import {
  enqueueTeamAlerts, ensurePushKeys, markAlertSent, requestTestAlert, savePushSubscription,
  unsentTeamAlerts,
} from '../src/queries/team-alerts.ts'
import type { QueryRunner } from '../src/runner.ts'

/**
 * A customer waiting on the team used to be visible only to somebody with the
 * inbox open. These are the alerts that reach a phone instead.
 */
const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations')
const OP = '11111111-1111-1111-1111-111111111111'
const ACCOUNT = '33333333-3333-3333-3333-333333333333'
const CONV = '66666666-6666-6666-6666-666666666666'
const CAR = '44444444-4444-4444-4444-444444444444'
const SALES = '88888888-8888-8888-8888-888888888888'
const OPS = '88888888-8888-8888-8888-888888888889'

let db: PGlite
let run: QueryRunner

beforeEach(async () => {
  db = await PGlite.create()
  run = async (t, p) => (await db.query(t, p)).rows as Array<Record<string, unknown>>
  for (const f of readdirSync(migrationsDir).filter((n) => n.endsWith('.sql')).sort()) {
    await db.exec(readFileSync(join(migrationsDir, f), 'utf8'))
  }
  await db.exec(`
    insert into operators (id, name, timezone, handoff_sla_minutes) values ('${OP}', 'Vyra Pilot', 'Asia/Dubai', 15);
    insert into memberships (id, operator_id, user_id, role, display_name) values
      ('${SALES}', '${OP}', '99999999-9999-9999-9999-999999999999', 'salesperson', 'Sara'),
      ('${OPS}', '${OP}', '99999999-9999-9999-9999-999999999998', 'operations', 'Omar');
    insert into whatsapp_accounts (id, operator_id, provider_account_id, phone_number_id)
    values ('${ACCOUNT}', '${OP}', 'waba', '111');
    insert into contacts (id, operator_id, channel_identifier, display_name)
    values ('55555555-5555-5555-5555-555555555555', '${OP}', '971500000001', 'Elena');
    insert into conversations (id, operator_id, contact_id, whatsapp_account_id)
    values ('${CONV}', '${OP}', '55555555-5555-5555-5555-555555555555', '${ACCOUNT}');
    insert into vehicles (id, operator_id, make, model, variant, year, colour, category,
                          plate, chassis_number, provenance, confirmed_by)
    values ('${CAR}', '${OP}', 'Lamborghini', 'Huracán', 'EVO', 2023, 'Verde', 'exotic',
            'D 1', 'V1', 'operator_confirmed', 'Owner');
  `)
  for (const [membershipId, endpoint] of [[SALES, 'https://push.example/sara'], [OPS, 'https://push.example/omar']]) {
    await savePushSubscription(run, {
      operatorId: OP, membershipId: membershipId!, endpoint: endpoint!, p256dh: 'k', auth: 'a', userAgent: null,
    })
  }
})

const sweep = async () => {
  await enqueueTeamAlerts(run)
  return unsentTeamAlerts(run)
}

describe('team alerts', () => {
  it('makes one key pair and keeps it', async () => {
    const first = await ensurePushKeys(run)
    expect(Buffer.from(first.publicKey, 'base64url')).toHaveLength(65)
    expect(Buffer.from(first.privateKey, 'base64url')).toHaveLength(32)
    expect(await ensurePushKeys(run)).toEqual(first)
  })

  it('tells the people who answer customers about a handoff, once', async () => {
    await raiseHandoff(run, { operatorId: OP, conversationId: CONV, reason: 'agent_uncertain', summary: 'Asked about Abu Dhabi.' })
    const [alert, ...rest] = await sweep()
    expect(rest).toHaveLength(0)
    expect(alert).toMatchObject({
      title: 'Elena needs a person', body: 'Asked about Abu Dhabi.', url: `/conversations/${CONV}`,
      // Operations never replies to a customer, so is not woken for one.
      devices: [{ endpoint: 'https://push.example/sara', p256dh: 'k', auth: 'a' }],
    })
    await markAlertSent(run, { id: alert!.id, delivered: 1, endpoints: ['https://push.example/sara'] })

    // Raised again at the same priority: the same job, not a new alert.
    await raiseHandoff(run, { operatorId: OP, conversationId: CONV, reason: 'agent_uncertain', summary: 'And the km.' })
    expect(await sweep()).toHaveLength(0)

    // Raised to urgent: that is new.
    await raiseHandoff(run, { operatorId: OP, conversationId: CONV, reason: 'safety_or_accident', summary: 'Accident.' })
    const [urgent] = await sweep()
    expect(urgent!.title).toBe('Urgent: Elena needs a person')
  })

  it('tells them again when nobody picks it up in time', async () => {
    await raiseHandoff(run, { operatorId: OP, conversationId: CONV, reason: 'agent_uncertain', summary: 'Km?' })
    for (const a of await sweep()) await markAlertSent(run, { id: a.id, delivered: 1, endpoints: [] })
    await run(`update handoffs set due_at = now() - interval '1 minute', created_at = now() - interval '16 minutes'`, [])
    const [late, ...rest] = await sweep()
    expect(rest).toHaveLength(0)
    expect(late).toMatchObject({ title: 'Still waiting: Elena' })
    expect(late!.body).toMatch(/^Nobody has picked this up for 16 minutes\./)

    // Accepted: nothing more.
    await run(`update handoffs set state = 'accepted', accepted_at = now(), owner_membership_id = $1`, [SALES])
    await run(`update team_alerts set sent_at = now()`, [])
    await run(`update handoffs set due_at = now() - interval '2 minutes'`, [])
    expect(await sweep()).toHaveLength(0)
  })

  it('tells them a booking is waiting for a yes, with what it is', async () => {
    const [e] = await run(`insert into enquiries (operator_id, conversation_id) values ($1, $2) returning id`, [OP, CONV])
    const [q] = await run(
      `insert into quotes (operator_id, conversation_id, enquiry_id, vehicle_id, revision, state, total_minor,
                           lines, start_date, end_date, days, valid_until)
       values ($1, $2, $3, $4, 1, 'draft', 3300000, '[]'::jsonb, '2026-09-26', '2026-10-02', 6, now() + interval '1 day')
       returning id`, [OP, CONV, e!['id'], CAR])
    await run(`insert into bookings (operator_id, conversation_id, enquiry_id, quote_id) values ($1, $2, $3, $4)`,
      [OP, CONV, e!['id'], q!['id']])
    const [alert] = await sweep()
    expect(alert).toMatchObject({
      title: 'Booking to confirm: Elena',
      body: 'Lamborghini Huracán, 26 Sep to 2 Oct, AED 33,000. The customer is waiting for your yes.',
      url: '/bookings',
    })
  })

  it('tells them when the agent is waiting on an answer from the team', async () => {
    await run(`update conversations set next_action = 'Waiting on you: confirm the km included' where id = $1`, [CONV])
    const [alert] = await sweep()
    expect(alert).toMatchObject({ title: 'Elena is waiting on an answer', body: 'confirm the km included' })
  })

  it('sends a test alert to the person who asked, and nobody else', async () => {
    await requestTestAlert(run, { operatorId: OP, membershipId: OPS })
    const [alert] = await unsentTeamAlerts(run)
    expect(alert!.devices).toEqual([{ endpoint: 'https://push.example/omar', p256dh: 'k', auth: 'a' }])
  })

  it('leaves history alone', async () => {
    await raiseHandoff(run, { operatorId: OP, conversationId: CONV, reason: 'agent_uncertain', summary: 'Old.' })
    await run(`update handoffs set updated_at = now() - interval '2 days', due_at = now() - interval '2 days'`, [])
    expect(await sweep()).toHaveLength(0)
  })
})

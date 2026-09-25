import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { beforeEach, describe, expect, it } from 'vitest'
import { POLICY_TOPICS } from '../../contracts/src/policy-topics.ts'
import { getAutonomyState, setAutonomous } from '../src/queries/autonomy.ts'
import type { QueryRunner } from '../src/runner.ts'

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations')
const OP = '11111111-1111-1111-1111-111111111111'
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
    insert into operators (id, name) values ('${OP}', 'Brand New Rentals');
    -- A published answer needs an account behind it, so the operator needs one.
    insert into memberships (id, operator_id, user_id, role)
    values ('${MEMBER}', '${OP}', '99999999-9999-9999-9999-999999999999', 'admin');
  `)
})

const addCar = (photos: string[] | null = null) =>
  run(
    `insert into vehicles (operator_id, make, model, year, colour, category, plate,
                           chassis_number, provenance, confirmed_by, photo_urls)
     values ($1,'Lamborghini','Huracán',2023,'Verde','exotic',$2,$3,
             'operator_confirmed','Owner',$4::jsonb) returning id`,
    [OP, `P${Math.random()}`, `V${Math.random()}`, photos === null ? null : JSON.stringify(photos)],
  )

const publish = (topic: string, confirmedBy = 'Owner') =>
  run(
    `insert into knowledge_entries (operator_id, topic, covers, answer, version, provenance,
                                    confirmed_by, confirmed_by_membership_id, confirmed_at,
                                    published_at, published_by_membership_id, effective_from)
     values ($1, $2, 'covers', 'answer', 1, 'operator_confirmed', $3, $4, now(), now(), $4,
             now() - interval '1 hour')`,
    [OP, topic, confirmedBy, MEMBER],
  )

/** Everything autonomy needs, on an operator that has done its setup. */
const ready = async () => {
  const [car] = await addCar(['https://example.com/car.jpg'])
  await run(
    `insert into vehicle_rates (operator_id, vehicle_id, currency, daily_rate_minor, minimum_days,
                                provenance, confirmed_by, confirmed_at)
     values ($1, $2, 'AED', 550000, 1, 'operator_confirmed', 'Owner', now())`, [OP, car!['id']])
  for (const topic of POLICY_TOPICS) await publish(topic)
  await run(`insert into whatsapp_accounts (operator_id, provider_account_id, phone_number_id) values ($1, 'waba', '111')`, [OP])
  await run(`update memberships set display_name = 'Usama' where id = $1`, [MEMBER])
  await run(
    `update operators set availability_calendar_complete = true, ai_sending_enabled = true, auto_confirm_bookings = true,
            auto_confirm_limit_minor = 15000000, auto_confirm_max_days = 30 where id = $1`, [OP])
  await run(
    `insert into push_subscriptions (operator_id, membership_id, endpoint, p256dh, auth) values ($1, $2, 'https://push.example/1', 'k', 'a')`,
    [OP, MEMBER])
}

describe('switching the agent to autonomous', () => {
  it('refuses while something it needs is missing, and says what', async () => {
    const state = await getAutonomyState(run, OP)
    expect(state.on).toBe(false)
    expect(state.missing).toBeGreaterThan(0)
    const tried = await setAutonomous(run, { operatorId: OP, membershipId: MEMBER, on: true })
    expect(tried.ok).toBe(false)
    expect((tried as { missing: string[] }).missing).toContain('Turn on alerts on at least one phone')
  })

  it('turns on once everything that matters is in place, and records who did it', async () => {
    await ready()
    const state = await getAutonomyState(run, OP)
    expect(state.items.filter((i) => i.blocking && !i.done).map((i) => i.key)).toEqual([])
    expect(await setAutonomous(run, { operatorId: OP, membershipId: MEMBER, on: true })).toEqual({ ok: true, on: true })
    const after = await getAutonomyState(run, OP)
    expect(after).toMatchObject({ on: true, setBy: 'Usama' })
  })

  /** An operator who wants a person back must never be stopped by a checklist. */
  it('always turns off', async () => {
    await ready()
    await setAutonomous(run, { operatorId: OP, membershipId: MEMBER, on: true })
    await run(`delete from push_subscriptions`, [])
    expect(await setAutonomous(run, { operatorId: OP, membershipId: MEMBER, on: false })).toEqual({ ok: true, on: false })
  })

  it('says plainly what still reaches a person, without blocking on it', async () => {
    const later = (await getAutonomyState(run, OP)).items.filter((i) => i.later === true)
    expect(later.map((i) => i.key)).toEqual(['payments', 'templates'])
    expect(later.every((i) => !i.blocking)).toBe(true)
  })

  it('needs the cancellation answer like every other', async () => {
    await ready()
    await run(`delete from knowledge_entries where topic = 'cancellation'`, [])
    const answers = (await getAutonomyState(run, OP)).items.find((i) => i.key === 'answers')!
    expect(answers).toMatchObject({ done: false, blocking: true })
  })
})

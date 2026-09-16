import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { beforeEach, describe, expect, it } from 'vitest'
import { POLICY_TOPICS } from '../../contracts/src/policy-topics.ts'
import { getSetupState, whoConfirmedTheAnswers } from '../src/queries/setup.ts'
import type { QueryRunner } from '../src/runner.ts'

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations')
const OP = '11111111-1111-1111-1111-111111111111'

let db: PGlite
let run: QueryRunner

beforeEach(async () => {
  db = await PGlite.create()
  run = async (t, p) => (await db.query(t, p)).rows as Array<Record<string, unknown>>
  for (const f of readdirSync(migrationsDir).filter((n) => n.endsWith('.sql')).sort()) {
    await db.exec(readFileSync(join(migrationsDir, f), 'utf8'))
  }
  await db.exec(`insert into operators (id, name) values ('${OP}', 'Brand New Rentals');`)
})

const step = async (key: string) =>
  (await getSetupState(run, OP)).steps.find((s) => s.key === key)!

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
                                    confirmed_by, confirmed_at, published_at, effective_from)
     values ($1, $2, 'covers', 'answer', 1, 'operator_confirmed', $3, now(), now(),
             now() - interval '1 hour')`,
    [OP, topic, confirmedBy],
  )

describe('a brand new operator', () => {
  it('cannot sell, and says which things stop it', async () => {
    const setup = await getSetupState(run, OP)

    expect(setup.blocked).toBeGreaterThan(0)
    expect(setup.steps.filter((s) => s.blocking && !s.done).map((s) => s.key))
      .toEqual(['whatsapp', 'fleet', 'rates', 'answers'])
  })

  /**
   * The distinction the page rests on. "Nobody named to escalate to" is worth
   * fixing and is not the reason nothing is selling.
   */
  it('separates what stops it working from what makes it better', async () => {
    const setup = await getSetupState(run, OP)
    expect(setup.steps.filter((s) => !s.blocking).map((s) => s.key))
      .toEqual(['follow-up-wording', 'photos', 'fallback', 'autosend'])
  })

  /** Switching it on with nothing behind it is how an operator decides this does not work. */
  it('puts letting the agent reply last', async () => {
    const setup = await getSetupState(run, OP)
    expect(setup.steps.at(-1)!.key).toBe('autosend')
  })
})

describe('the fleet steps', () => {
  it('counts the cars that are actually confirmed', async () => {
    await addCar()
    expect(await step('fleet')).toMatchObject({ done: true, detail: '1 car on file.' })
  })

  it('is not finished while one car has no rate', async () => {
    await addCar()
    await addCar()
    const [car] = await run(`select id from vehicles limit 1`, [])
    await run(
      `insert into vehicle_rates (operator_id, vehicle_id, currency, daily_rate_minor,
                                  confirmed_by, confirmed_at)
       values ($1, $2, 'AED', 350000, 'Owner', now())`,
      [OP, car!['id']],
    )

    expect(await step('rates')).toMatchObject({ done: false, detail: '1 car priced, of 2.' })
  })

  /** With no cars there is nothing to say about prices, so it says nothing. */
  it('says nothing about rates before there are cars', async () => {
    expect(await step('rates')).toMatchObject({ done: false, detail: null })
  })

  it('counts photographs separately, and does not block on them', async () => {
    await addCar(['https://example.com/one.jpg'])
    await addCar()

    expect(await step('photos'))
      .toMatchObject({ done: false, blocking: false, detail: '1 car with photographs, of 2.' })
  })
})

describe('the answers', () => {
  it('counts the topics answered against the ones that exist', async () => {
    await publish('deposit')
    expect(await step('answers'))
      .toMatchObject({ done: false, detail: `1 of ${POLICY_TOPICS.length} answered.` })
  })

  it('is finished once every topic has one', async () => {
    for (const topic of POLICY_TOPICS) await publish(topic)
    expect(await step('answers')).toMatchObject({ done: true })
  })

  /**
   * Chasing needs wording of its own, and the second chase needs different
   * wording again. One answer reused for both is what sent the same sentence
   * twice, thirty minutes apart.
   */
  it('asks for the follow-up wording separately from the rule', async () => {
    await publish('follow-up-timing')
    expect(await step('follow-up-wording')).toMatchObject({ done: false })
  })

  it('is not finished until both chases have their own words', async () => {
    await publish('follow-up-message')
    expect(await step('follow-up-wording'))
      .toMatchObject({ done: false, detail: expect.stringContaining('one to go') })

    await publish('follow-up-message-2')
    expect(await step('follow-up-wording')).toMatchObject({ done: true, detail: 'Both published.' })
  })
})

/**
 * Provenance stopped being able to answer this: publishing sets it to
 * operator_confirmed whatever the content was. The signature is the only
 * evidence left that a person agreed to an answer.
 */
describe('who confirmed the answers', () => {
  it('groups the published answers by who signed them', async () => {
    await publish('deposit', 'Sara')
    await publish('delivery-areas', 'Sara')
    await publish('business-hours', 'DEMO DATA — not confirmed by an operator')

    expect(await whoConfirmedTheAnswers(run, OP)).toEqual([
      { confirmedBy: 'Sara', topics: 2 },
      { confirmedBy: 'DEMO DATA — not confirmed by an operator', topics: 1 },
    ])
  })

  it('has nothing to report before anything is published', async () => {
    expect(await whoConfirmedTheAnswers(run, OP)).toEqual([])
  })
})

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
                                    confirmed_by, confirmed_by_membership_id, confirmed_at,
                                    published_at, published_by_membership_id, effective_from)
     values ($1, $2, 'covers', 'answer', 1, 'operator_confirmed', $3, $4, now(), now(), $4,
             now() - interval '1 hour')`,
    [OP, topic, confirmedBy, MEMBER],
  )

describe('a brand new operator', () => {
  it('cannot sell, and says which things stop it', async () => {
    const setup = await getSetupState(run, OP)

    expect(setup.blocked).toBeGreaterThan(0)
    expect(setup.steps.filter((s) => s.blocking && !s.done).map((s) => s.key))
      .toEqual(['whatsapp', 'fleet', 'rates', 'answers', 'names'])
  })

  /**
   * The distinction the page rests on. "Nobody named to escalate to" is worth
   * fixing and is not the reason nothing is selling.
   */
  it('separates what stops it working from what makes it better', async () => {
    const setup = await getSetupState(run, OP)
    expect(setup.steps.filter((s) => !s.blocking).map((s) => s.key))
      .toEqual([
        'automated-messages', 'hours', 'calendar', 'follow-up-wording',
        'photos', 'fallback', 'autosend',
      ])
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

/**
 * The checklist counted every published topic as a policy answer, so the four
 * automated messages read as four answered policy questions. A pilot with
 * none of the six answered was told on its own setup page that it had four —
 * which is the worst direction for this particular screen to be wrong in,
 * because the whole point of it is telling somebody what is left.
 */
describe('what counts as an answered policy question', () => {
  const publish = async (topic: string) => {
    const [e] = await run(
      // A published row carries the accounts behind it:
      // knowledge_published_requires_a_real_person.
      `insert into knowledge_entries (operator_id, topic, answer, provenance, confirmed_by,
                                      confirmed_at, version, published_at, effective_from,
                                      confirmed_by_membership_id, published_by_membership_id)
       values ($1, $2, 'something', 'operator_confirmed', 'Owner', now(), 1, now(), now(),
               $3, $3) returning id`,
      [OP, topic, MEMBER],
    )
    return e!['id'] as string
  }

  const answersStep = async () =>
    (await getSetupState(run, OP)).steps.find((s) => s.key === 'answers')!

  it('does not count an automated message as one', async () => {
    await publish('greeting')
    await publish('out-of-hours')
    const step = await answersStep()
    expect(step.done).toBe(false)
    expect(step.detail).toBe('0 of 6 answered.')
  })

  it('counts a real one', async () => {
    await publish('deposit')
    expect((await answersStep()).detail).toBe('1 of 6 answered.')
  })

  /** And the messages have a step of their own, which they did not. */
  it('counts them under the messages step instead', async () => {
    await publish('greeting')
    await publish('out-of-hours')
    const step = (await getSetupState(run, OP)).steps.find((s) => s.key === 'automated-messages')!
    expect(step.done).toBe(true)
  })
})

/**
 * Nobody without a name can send at all — the path refuses rather than going
 * out unsigned — and they find that out the moment they try to answer a
 * customer. That belongs on the list of things stopping the agent selling.
 */
describe('people who cannot reply yet', () => {
  it('blocks while somebody who replies has no name', async () => {
    const step = (await getSetupState(run, OP)).steps.find((s) => s.key === 'names')!
    expect(step).toMatchObject({ done: false, blocking: true })
  })

  it('clears once they all have one', async () => {
    await run(
      `update memberships set display_name = 'Ahmed'
       where operator_id = $1 and role in ('admin','manager','salesperson')`, [OP],
    )
    expect((await getSetupState(run, OP)).steps.find((s) => s.key === 'names')!.done).toBe(true)
  })

  /** Operations never replies to a customer, so a missing name stops nothing. */
  it('ignores a role that does not reply', async () => {
    await run(
      `update memberships set display_name = 'Ahmed'
       where operator_id = $1 and role in ('admin','manager','salesperson')`, [OP],
    )
    await run(
      `insert into memberships (operator_id, user_id, role, active)
       values ($1, '10000000-0000-0000-0000-0000000000ff', 'operations', true)`, [OP],
    )
    expect((await getSetupState(run, OP)).steps.find((s) => s.key === 'names')!.done).toBe(true)
  })
})

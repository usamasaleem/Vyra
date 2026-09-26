import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { beforeEach, describe, expect, it } from 'vitest'
import { getNavCounts } from '../src/queries/nav-counts.ts'
import { listOpenHandoffs } from '../src/queries/handoff-queue.ts'
import { listOpenOperationsRequests } from '../src/queries/operations.ts'
import { listRates } from '../src/queries/quotes.ts'
import { listKnowledge } from '../src/queries/knowledge.ts'
import { listAvailability } from '../src/queries/availability.ts'
import { getMetrics } from '../src/queries/metrics.ts'
import { getAgentCosts } from '../src/queries/agent-runs.ts'
import { getQueueWaits } from '../src/queries/queue-health.ts'
import { listMembers, listNotes } from '../src/queries/collaboration.ts'
import { addNote } from '../src/queries/collaboration.ts'
import { setVehicleRate } from '../src/queries/quotes.ts'
import { recordUnavailable } from '../src/queries/availability.ts'
import { addVehicle } from '../src/queries/add-vehicle.ts'
import type { QueryRunner, Transactor } from '../src/runner.ts'

/**
 * Build plan step 14 — the queries the inbox actually runs, run as the role it
 * actually uses.
 *
 * rls.test.ts proves the policies refuse what they should. This proves the
 * opposite half, which is where switching the application over goes wrong: a
 * page that reads a table vyra_app was never granted does not leak anything,
 * it 500s. The grants were written table by table across six migrations, and
 * nothing had ever exercised them together, because nothing had ever entered
 * the role outside a test.
 *
 * It caught one immediately. The reports page reads the job queue, which lives
 * in graphile_worker's own schema and is not granted to vyra_app at all —
 * correctly, since it holds every operator's jobs. That read stays privileged
 * and says so at the call site.
 */

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations')
const OP_A = '11111111-1111-1111-1111-111111111111'
const OP_B = '22222222-2222-2222-2222-222222222222'
const USER_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const CONV_A = 'cccccccc-cccc-cccc-cccc-cccccccccccc'
const CONV_B = 'dddddddd-dddd-dddd-dddd-dddddddddddd'

let db: PGlite
let MEMBERSHIP_A: string
let vehicleA: string

/**
 * A runner that behaves like actorRunner in the inbox: one transaction per
 * statement, identified user, restricted role, everything reverted at the end.
 */
function asUser(userId: string): QueryRunner {
  return async (text, params = []) => {
    await db.exec('begin')
    try {
      await db.query(`select set_config('app.current_user_id', $1, true)`, [userId])
      await db.exec(`set local role vyra_app`)
      const result = await db.query(text, params as unknown[])
      await db.exec('commit')
      return result.rows as Array<Record<string, unknown>>
    } catch (error) {
      await db.exec('rollback')
      throw error
    }
  }
}

beforeEach(async () => {
  db = await PGlite.create()
  for (const f of readdirSync(migrationsDir).filter((n) => n.endsWith('.sql')).sort()) {
    await db.exec(readFileSync(join(migrationsDir, f), 'utf8'))
  }
  await db.exec(`
    insert into operators (id, name) values ('${OP_A}', 'Vyra Pilot'), ('${OP_B}', 'Rival Rentals');
    insert into memberships (operator_id, user_id, role) values ('${OP_A}', '${USER_A}', 'admin');
    insert into whatsapp_accounts (id, operator_id, provider_account_id, phone_number_id) values
      ('e1111111-1111-1111-1111-111111111111', '${OP_A}', 'waba-a', '111'),
      ('e2222222-2222-2222-2222-222222222222', '${OP_B}', 'waba-b', '222');
    insert into contacts (id, operator_id, channel_identifier) values
      ('f1111111-1111-1111-1111-111111111111', '${OP_A}', '971500000001'),
      ('f2222222-2222-2222-2222-222222222222', '${OP_B}', '971500000002');
    insert into conversations (id, operator_id, contact_id, whatsapp_account_id) values
      ('${CONV_A}', '${OP_A}', 'f1111111-1111-1111-1111-111111111111', 'e1111111-1111-1111-1111-111111111111'),
      ('${CONV_B}', '${OP_B}', 'f2222222-2222-2222-2222-222222222222', 'e2222222-2222-2222-2222-222222222222');
    insert into vehicles (operator_id, make, model, year, colour, category, plate, chassis_number,
                          provenance, confirmed_by)
    values ('${OP_A}','Lamborghini','Huracán',2023,'Verde','exotic','D 1','VIN1','operator_confirmed','Owner'),
           ('${OP_B}','Ferrari','488',2022,'Rosso','exotic','D 2','VIN2','operator_confirmed','Rival');
  `)

  const privileged = async (text: string, params: unknown[] = []) =>
    (await db.query(text, params)).rows as Array<Record<string, unknown>>

  MEMBERSHIP_A = (await privileged(
    `select id from memberships where user_id = $1`, [USER_A],
  ))[0]!['id'] as string
  vehicleA = (await privileged(
    `select id from vehicles where operator_id = $1`, [OP_A],
  ))[0]!['id'] as string
})

/**
 * Every read a signed-in page performs. The assertion is mostly that it does
 * not throw: a missing grant raises "permission denied", which is a 500 on a
 * page a salesperson uses all day.
 */
describe('the pages work as the restricted role', () => {
  const run = () => asUser(USER_A)
  const since = () => new Date(Date.now() - 7 * 86_400_000)

  it('reads the navigation badge counts', async () => {
    await expect(getNavCounts(run(), OP_A)).resolves.toBeDefined()
  })

  it('reads the handoff queue', async () => {
    await expect(listOpenHandoffs(run(), OP_A, {})).resolves.toEqual([])
  })

  it('reads the operations queue', async () => {
    await expect(listOpenOperationsRequests(run(), OP_A)).resolves.toEqual([])
  })

  it('reads rates, answers and availability', async () => {
    await expect(listRates(run(), OP_A)).resolves.toBeDefined()
    await expect(listKnowledge(run(), OP_A)).resolves.toEqual([])
    await expect(listAvailability(run(), OP_A)).resolves.toEqual([])
  })

  /**
   * The conversation page, which is the one this whole test file existed to
   * protect and did not. listMembers reads staff emails out of Supabase's auth
   * schema, which vyra_app cannot see — so wiring the restricted role took that
   * one page down and left every other page working, because the reassign
   * dropdown is the only place in the application that asks who anybody is.
   *
   * PGlite has no auth schema, so this passes here whether the definer function
   * exists or not. It is kept because the shape of the call is still worth
   * asserting, and the comment is worth more: a query that reaches outside the
   * public schema cannot be proven safe by this suite, and has to be checked
   * against the real database.
   */
  it('reads the conversation page', async () => {
    await expect(listNotes(run(), OP_A, CONV_A)).resolves.toEqual([])
    await expect(listMembers(run(), OP_A)).resolves.toHaveLength(1)
  })

  it('reads the reports page', async () => {
    await expect(getMetrics(run(), OP_A, since())).resolves.toBeDefined()
    await expect(getAgentCosts(run(), OP_A, since())).resolves.toBeDefined()
    await expect(getQueueWaits(run(), OP_A, since())).resolves.toBeDefined()
  })
})

describe('and they are scoped while doing it', () => {
  /**
   * The same call, with the same operator id, run by somebody who does not
   * hold that membership. The argument is a request; the policy is the answer.
   */
  it('returns nothing for an operator the user is not a member of', async () => {
    const rates = await listRates(asUser(USER_A), OP_B)
    expect(rates).toEqual([])
  })

  it('sees only its own fleet when nothing filters by operator at all', async () => {
    const rows = await asUser(USER_A)('select model from vehicles', [])
    expect(rows.map((r) => r['model'])).toEqual(['Huracán'])
  })
})

/**
 * The writes, which is where a missing grant actually bites: a page that
 * cannot read shows an error, a page that cannot write loses the salesperson's
 * work after they typed it.
 */
describe('the actions work as the restricted role', () => {
  const run = () => asUser(USER_A)

  it('adds a note', async () => {
    const { noteId } = await addNote(run(), {
      operatorId: OP_A, conversationId: CONV_A, membershipId: MEMBERSHIP_A, body: 'called him back',
    })
    expect(noteId).not.toBeNull()
  })

  it('sets a rate, which also writes an audit record', async () => {
    await expect(
      setVehicleRate(run(), {
        operatorId: OP_A, vehicleId: vehicleA, confirmedBy: 'Sara', dailyRateMinor: 350_000,
      }),
    ).resolves.toBeDefined()
  })

  it('records an availability block', async () => {
    await expect(
      recordUnavailable(run(), {
        operatorId: OP_A, vehicleId: vehicleA,
        startDate: '2026-09-20', endDate: '2026-09-23', reason: 'booked', recordedBy: 'Sara',
      }),
    ).resolves.toBeDefined()
  })

  /**
   * Adding a car is three writes that must agree — the car, its rate and the
   * audit record — in one restricted transaction, the way actorTransactor
   * runs it in the inbox.
   */
  it('adds a car with its rate', async () => {
    const transact: Transactor = async (fn) => {
      await db.exec('begin')
      try {
        await db.query(`select set_config('app.current_user_id', $1, true)`, [USER_A])
        await db.exec(`set local role vyra_app`)
        const out = await fn(async (t, p = []) => (await db.query(t, p as unknown[])).rows as Array<Record<string, unknown>>)
        await db.exec('commit')
        return out
      } catch (error) {
        await db.exec('rollback')
        throw error
      }
    }
    const added = await addVehicle(transact, {
      operatorId: OP_A, membershipId: MEMBERSHIP_A, confirmedBy: 'Sara',
      make: 'Lamborghini', model: 'Urus', year: 2024, colour: 'Nero', category: 'suv',
      plate: 'D 3', chassisNumber: 'VIN3', dailyRateMinor: 350_000,
    })
    expect(added.ok).toBe(true)
  })

  /** The note belongs to a conversation this user cannot see, so nothing is written. */
  it('cannot write into another operator conversation', async () => {
    const { noteId } = await addNote(run(), {
      operatorId: OP_B, conversationId: CONV_B, membershipId: MEMBERSHIP_A, body: 'injected',
    })
    expect(noteId).toBeNull()
  })
})

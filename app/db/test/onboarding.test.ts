import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  acceptInvitation, createOperatorWithAdmin, findPendingInvitation, inviteMember,
  listTeam, revokeInvitation, setMemberActive, setMemberRole,
} from '../src/queries/onboarding.ts'
import type { QueryRunner, Transactor } from '../src/runner.ts'

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations')
const OWNER = '10000000-0000-0000-0000-000000000001'
const SECOND = '10000000-0000-0000-0000-000000000002'

let db: PGlite
let run: QueryRunner
let transact: Transactor

beforeEach(async () => {
  db = await PGlite.create()
  run = async (t, p) => (await db.query(t, p)).rows as Array<Record<string, unknown>>
  transact = async (fn) => {
    let out: unknown
    await db.transaction(async (tx) => {
      out = await fn(async (text, params) => (await tx.query(text, params)).rows as Array<Record<string, unknown>>)
    })
    return out as never
  }
  for (const f of readdirSync(migrationsDir).filter((n) => n.endsWith('.sql')).sort()) {
    await db.exec(readFileSync(join(migrationsDir, f), 'utf8'))
  }
})

const newOperator = (name = 'Vyra Pilot', userId = OWNER) =>
  createOperatorWithAdmin(transact, { name, timezone: 'Asia/Dubai', userId })

describe('signing up as a new operator', () => {
  it('creates the company and makes them its administrator', async () => {
    const { operatorId, membershipId } = await newOperator()

    const [member] = await run(
      `select role::text as role, active, user_id from memberships where id = $1`, [membershipId],
    )
    expect(member).toMatchObject({ role: 'admin', active: true, user_id: OWNER })

    const [operator] = await run(`select name, timezone from operators where id = $1`, [operatorId])
    expect(operator).toMatchObject({ name: 'Vyra Pilot', timezone: 'Asia/Dubai' })
  })

  /** The AI does not start talking to customers because somebody signed up. */
  it('leaves automatic replies switched off', async () => {
    const { operatorId } = await newOperator()
    const [operator] = await run(
      `select ai_sending_enabled from operators where id = $1`, [operatorId],
    )
    expect(operator!['ai_sending_enabled']).toBe(false)
  })

  it('records who created it', async () => {
    const { operatorId } = await newOperator()
    const [event] = await run(
      `select action, subject_id from audit_events where operator_id = $1`, [operatorId],
    )
    expect(event).toMatchObject({ action: 'operator.created', subject_id: operatorId })
  })

  /** Two companies, two sets of people, no relationship between them. */
  it('keeps two operators entirely separate', async () => {
    const a = await newOperator('Vyra Pilot', OWNER)
    const b = await newOperator('Rival Rentals', SECOND)

    expect(a.operatorId).not.toBe(b.operatorId)
    expect((await listTeam(run, a.operatorId)).members).toHaveLength(1)
    expect((await listTeam(run, b.operatorId)).members).toHaveLength(1)
  })
})

describe('inviting somebody', () => {
  it('waits for them under the address they were invited at', async () => {
    const { operatorId, membershipId } = await newOperator()
    await inviteMember(run, {
      operatorId, email: '  Sara@Example.com ', role: 'salesperson',
      invitedByMembershipId: membershipId,
    })

    // Case and spacing are the person typing, not the address.
    const found = await findPendingInvitation(run, 'SARA@example.com')
    expect(found).toMatchObject({ operatorId, role: 'salesperson', operatorName: 'Vyra Pilot' })
  })

  /** Inviting twice is a mistake to absorb, not a duplicate to reconcile later. */
  it('updates the role rather than inviting them twice', async () => {
    const { operatorId, membershipId } = await newOperator()
    const invite = (role: string) =>
      inviteMember(run, { operatorId, email: 'sara@example.com', role, invitedByMembershipId: membershipId })

    await invite('salesperson')
    await invite('manager')

    const { invited } = await listTeam(run, operatorId)
    expect(invited).toHaveLength(1)
    expect(invited[0]).toMatchObject({ role: 'manager' })
  })

  it('joins them at the role the admin chose', async () => {
    const { operatorId, membershipId } = await newOperator()
    await inviteMember(run, {
      operatorId, email: 'sara@example.com', role: 'manager', invitedByMembershipId: membershipId,
    })
    const invitation = await findPendingInvitation(run, 'sara@example.com')

    const result = await acceptInvitation(transact, { invitationId: invitation!.id, userId: SECOND })

    expect(result).toMatchObject({ accepted: true, operatorId })
    const [member] = await run(
      `select role::text as role, active from memberships where user_id = $1`, [SECOND],
    )
    expect(member).toMatchObject({ role: 'manager', active: true })
  })

  /** Two tabs, or a revocation landing in the same second. */
  it('can only be accepted once', async () => {
    const { operatorId, membershipId } = await newOperator()
    await inviteMember(run, {
      operatorId, email: 'sara@example.com', role: 'salesperson', invitedByMembershipId: membershipId,
    })
    const invitation = await findPendingInvitation(run, 'sara@example.com')

    await acceptInvitation(transact, { invitationId: invitation!.id, userId: SECOND })
    const again = await acceptInvitation(transact, { invitationId: invitation!.id, userId: SECOND })

    expect(again.accepted).toBe(false)
    expect(await run(`select id from memberships where user_id = $1`, [SECOND])).toHaveLength(1)
  })

  it('stops waiting once it is revoked', async () => {
    const { operatorId, membershipId } = await newOperator()
    await inviteMember(run, {
      operatorId, email: 'sara@example.com', role: 'salesperson', invitedByMembershipId: membershipId,
    })
    const invitation = await findPendingInvitation(run, 'sara@example.com')

    expect(await revokeInvitation(run, { operatorId, invitationId: invitation!.id }))
      .toEqual({ revoked: true })
    expect(await findPendingInvitation(run, 'sara@example.com')).toBeNull()
  })

  /** Somebody switched off and invited again comes back, at the new role. */
  it('brings a deactivated colleague back', async () => {
    const { operatorId, membershipId } = await newOperator()
    await inviteMember(run, {
      operatorId, email: 'sara@example.com', role: 'salesperson', invitedByMembershipId: membershipId,
    })
    const first = await findPendingInvitation(run, 'sara@example.com')
    const joined = await acceptInvitation(transact, { invitationId: first!.id, userId: SECOND })
    await setMemberActive(run, { operatorId, membershipId: joined.membershipId!, active: false })

    await inviteMember(run, {
      operatorId, email: 'sara@example.com', role: 'manager', invitedByMembershipId: membershipId,
    })
    const second = await findPendingInvitation(run, 'sara@example.com')
    await acceptInvitation(transact, { invitationId: second!.id, userId: SECOND })

    const [member] = await run(
      `select role::text as role, active from memberships where user_id = $1`, [SECOND],
    )
    expect(member).toMatchObject({ role: 'manager', active: true })
  })
})

/**
 * An operator with no administrator is a company nobody can configure, add
 * staff to, or recover — and the person most likely to cause it is the only
 * administrator, tidying up.
 */
describe('the last administrator', () => {
  it('cannot demote themselves', async () => {
    const { operatorId, membershipId } = await newOperator()

    expect(await setMemberRole(run, { operatorId, membershipId, role: 'salesperson' }))
      .toEqual({ changed: false })
  })

  it('cannot switch themselves off', async () => {
    const { operatorId, membershipId } = await newOperator()

    expect(await setMemberActive(run, { operatorId, membershipId, active: false }))
      .toEqual({ changed: false })
  })

  it('can do either once there is a second one', async () => {
    const { operatorId, membershipId } = await newOperator()
    await inviteMember(run, {
      operatorId, email: 'sara@example.com', role: 'admin', invitedByMembershipId: membershipId,
    })
    const invitation = await findPendingInvitation(run, 'sara@example.com')
    await acceptInvitation(transact, { invitationId: invitation!.id, userId: SECOND })

    expect(await setMemberRole(run, { operatorId, membershipId, role: 'salesperson' }))
      .toEqual({ changed: true })
  })

  it('does not stop an ordinary member being switched off', async () => {
    const { operatorId, membershipId } = await newOperator()
    await inviteMember(run, {
      operatorId, email: 'sara@example.com', role: 'salesperson', invitedByMembershipId: membershipId,
    })
    const invitation = await findPendingInvitation(run, 'sara@example.com')
    const joined = await acceptInvitation(transact, { invitationId: invitation!.id, userId: SECOND })

    expect(await setMemberActive(run, { operatorId, membershipId: joined.membershipId!, active: false }))
      .toEqual({ changed: true })
  })
})

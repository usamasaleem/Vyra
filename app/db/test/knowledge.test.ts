import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  draftKnowledge, getApprovedAnswer, listKnowledge, publishKnowledge,
} from '../src/queries/knowledge.ts'
import type { QueryRunner, Transactor } from '../src/runner.ts'

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations')
const OP = '11111111-1111-1111-1111-111111111111'
const RIVAL = '22222222-2222-2222-2222-222222222222'
const STAFF = '88888888-8888-8888-8888-888888888888'

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
  await db.exec(`
    insert into operators (id, name) values ('${OP}', 'Vyra Pilot'), ('${RIVAL}', 'Rival');
    insert into memberships (id, operator_id, user_id, role)
    values ('${STAFF}', '${OP}', '99999999-9999-9999-9999-999999999999', 'admin');
  `)
})

const draft = (over: Record<string, unknown> = {}) => {
  const input: Record<string, unknown> = {
    operatorId: OP, topic: 'deposit',
    covers: 'what deposit is required',
    answer: 'AED 5,000, released within 14 working days.',
    ...over,
  }
  return draftKnowledge(run, {
    // A name is who made the call; the account is what makes it checkable.
    // Supplied here whenever the test supplies a name, so the tests that are
    // about something else are not all about this.
    confirmedByMembershipId: input['confirmedBy'] == null ? null : STAFF,
    ...input,
  } as Parameters<typeof draftKnowledge>[1])
}

describe('drafting', () => {
  it('starts at version 1 and is placeholder until someone confirms it', async () => {
    const d = await draft()
    expect(d).toMatchObject({ version: 1, provenance: 'placeholder' })
  })

  it('increments the version per topic', async () => {
    await draft()
    expect((await draft({ answer: 'AED 6,000.' })).version).toBe(2)
    expect((await draft({ topic: 'delivery', answer: 'Free in Dubai.' })).version).toBe(1)
  })

  it('marks an entry confirmed when a person is named', async () => {
    const d = await draft({ confirmedBy: 'Ahmed, operations manager' })
    expect(d.provenance).toBe('operator_confirmed')
  })

  it('does not publish anything by drafting', async () => {
    await draft({ confirmedBy: 'Ahmed' })
    expect(await getApprovedAnswer(run, OP, 'deposit')).toBeNull()
  })
})

describe('publishing', () => {
  it('publishes a confirmed draft and makes it the approved answer', async () => {
    const d = await draft({ confirmedBy: 'Ahmed, operations manager' })
    const result = await publishKnowledge(transact, { entryId: d.id, operatorId: OP, membershipId: STAFF })

    expect(result).toMatchObject({ published: true, version: 1, supersededVersion: null })
    const approved = await getApprovedAnswer(run, OP, 'deposit')
    expect(approved).toMatchObject({
      answer: 'AED 5,000, released within 14 working days.',
      version: 1,
      confirmedBy: 'Ahmed, operations manager',
    })
  })

  /** The property the whole design exists for. */
  it('refuses to publish content nobody confirmed', async () => {
    const d = await draft()
    expect(await publishKnowledge(transact, { entryId: d.id, operatorId: OP, membershipId: STAFF }))
      .toEqual({ published: false, reason: 'not_confirmed' })
    expect(await getApprovedAnswer(run, OP, 'deposit')).toBeNull()
  })

  /**
   * And the database refuses too, so a future query that bypasses the function
   * still cannot do it.
   */
  it('cannot be forced past the check constraint with direct SQL', async () => {
    const d = await draft()
    await expect(
      run(`update knowledge_entries set published_at = now(), effective_from = now() where id = $1`, [d.id]),
    ).rejects.toThrow(/knowledge_published_requires/)
  })

  /**
   * The seed script, exactly.
   *
   * It filled in every field the first constraint asked for — provenance
   * operator_confirmed, a confirmer, a timestamp, an effective_from — and wrote
   * the sentence "DEMO DATA — not confirmed by an operator" into the name. Nine
   * invented answers went live and the agent quoted them to real customers as
   * the operator's policy for four days.
   *
   * The constraint was not wrong. It asked for a name and got one. A string
   * cannot be false; it can only be untrue.
   */
  it('refuses an answer confirmed by a sentence rather than by an account', async () => {
    await expect(
      run(
        `insert into knowledge_entries
           (operator_id, topic, answer, version, provenance, confirmed_by, confirmed_at,
            published_at, effective_from)
         values ($1, 'deposit', 'AED 5,000.', 1, 'operator_confirmed',
                 'DEMO DATA — not confirmed by an operator', now(), now(), now())`,
        [OP],
      ),
    ).rejects.toThrow(/knowledge_published_requires_a_real_person/)
  })

  /** Confirmed by somebody, published by nobody, is still published by nobody. */
  it('refuses an answer nobody pressed publish on', async () => {
    await expect(
      run(
        `insert into knowledge_entries
           (operator_id, topic, answer, version, provenance, confirmed_by,
            confirmed_by_membership_id, confirmed_at, published_at, effective_from)
         values ($1, 'deposit', 'AED 5,000.', 1, 'operator_confirmed', 'Ahmed', $2,
                 now(), now(), now())`,
        [OP, STAFF],
      ),
    ).rejects.toThrow(/knowledge_published_requires_a_real_person/)
  })

  it('records the account behind the name when it does publish', async () => {
    const d = await draft({ confirmedBy: 'Ahmed, operations manager' })
    await publishKnowledge(transact, { entryId: d.id, operatorId: OP, membershipId: STAFF })

    const [row] = await run(
      `select confirmed_by, confirmed_by_membership_id, published_by_membership_id
       from knowledge_entries where id = $1`, [d.id],
    )
    expect(row).toMatchObject({
      // Both, because they answer different questions: who decided, and whose
      // account says so.
      confirmed_by: 'Ahmed, operations manager',
      confirmed_by_membership_id: STAFF,
      published_by_membership_id: STAFF,
    })
  })

  it('refuses to publish a name with no account behind it', async () => {
    const d = await draft({ confirmedBy: 'Ahmed', confirmedByMembershipId: null })
    expect(await publishKnowledge(transact, { entryId: d.id, operatorId: OP, membershipId: STAFF }))
      .toEqual({ published: false, reason: 'not_confirmed' })
    expect(await getApprovedAnswer(run, OP, 'deposit')).toBeNull()
  })

  it('supersedes the previous version rather than overwriting it', async () => {
    const first = await draft({ confirmedBy: 'Ahmed' })
    await publishKnowledge(transact, { entryId: first.id, operatorId: OP, membershipId: STAFF })

    const second = await draft({ answer: 'AED 7,500 from October.', confirmedBy: 'Ahmed' })
    const result = await publishKnowledge(transact, { entryId: second.id, operatorId: OP, membershipId: STAFF })

    expect(result).toMatchObject({ published: true, version: 2, supersededVersion: 1 })
    expect((await getApprovedAnswer(run, OP, 'deposit'))!.answer).toBe('AED 7,500 from October.')

    // The old answer is still readable, which is how an earlier quote is explained.
    const all = await listKnowledge(run, OP)
    expect(all.map((r) => r['version'])).toEqual([2, 1])
    expect(all.find((r) => r['version'] === 1)!['effective_to']).not.toBeNull()
  })

  it('refuses to publish the same entry twice', async () => {
    const d = await draft({ confirmedBy: 'Ahmed' })
    await publishKnowledge(transact, { entryId: d.id, operatorId: OP, membershipId: STAFF })
    expect(await publishKnowledge(transact, { entryId: d.id, operatorId: OP, membershipId: STAFF }))
      .toEqual({ published: false, reason: 'already_published' })
  })

  it('refuses another operator entry', async () => {
    const d = await draft({ confirmedBy: 'Ahmed' })
    expect(await publishKnowledge(transact, { entryId: d.id, operatorId: RIVAL, membershipId: STAFF }))
      .toEqual({ published: false, reason: 'not_found' })
  })
})

describe('reading the approved answer', () => {
  it('returns null when nothing is approved, rather than guessing', async () => {
    expect(await getApprovedAnswer(run, OP, 'included-kilometres')).toBeNull()
  })

  it('returns what was approved at a past moment, not what is approved now', async () => {
    const first = await draft({ confirmedBy: 'Ahmed' })
    await publishKnowledge(transact, { entryId: first.id, operatorId: OP, membershipId: STAFF })
    await run(`update knowledge_entries set effective_from = now() - interval '10 days' where version = 1`, [])

    const second = await draft({ answer: 'AED 7,500 from October.', confirmedBy: 'Ahmed' })
    await publishKnowledge(transact, { entryId: second.id, operatorId: OP, membershipId: STAFF })
    await run(`update knowledge_entries set effective_to = now() - interval '2 days' where version = 1`, [])
    await run(`update knowledge_entries set effective_from = now() - interval '2 days' where version = 2`, [])

    const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 3600 * 1000)
    expect((await getApprovedAnswer(run, OP, 'deposit', fiveDaysAgo))!.version).toBe(1)
    expect((await getApprovedAnswer(run, OP, 'deposit'))!.version).toBe(2)
  })

  it('does not leak another operator answers', async () => {
    const d = await draft({ confirmedBy: 'Ahmed' })
    await publishKnowledge(transact, { entryId: d.id, operatorId: OP, membershipId: STAFF })
    expect(await getApprovedAnswer(run, RIVAL, 'deposit')).toBeNull()
  })
})

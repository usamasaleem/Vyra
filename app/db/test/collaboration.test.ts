import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  addNote, assignConversation, listMembers, listNotes, setPriority,
} from '../src/queries/collaboration.ts'
import { queueOutboundText } from '../src/queries/outbound.ts'
import type { QueryRunner } from '../src/runner.ts'

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations')
const OPERATOR = '11111111-1111-1111-1111-111111111111'
const RIVAL = '22222222-2222-2222-2222-222222222222'
const CONVERSATION = '66666666-6666-6666-6666-666666666666'
const SALES = '88888888-8888-8888-8888-888888888888'
const MANAGER = '99999999-9999-9999-9999-999999999999'
const RIVAL_MEMBER = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'

let db: PGlite
let run: QueryRunner

beforeEach(async () => {
  db = await PGlite.create()
  run = async (t, p) => (await db.query(t, p)).rows as Array<Record<string, unknown>>
  for (const f of readdirSync(migrationsDir).filter((n) => n.endsWith('.sql')).sort()) {
    await db.exec(readFileSync(join(migrationsDir, f), 'utf8'))
  }
  /**
   * Supabase owns the auth schema and it does not exist here. Created AFTER
   * the migrations so the guarded foreign key in 0003 correctly skips itself,
   * exactly as it does on a fresh test database.
   */
  await db.exec(`
    create schema if not exists auth;
    create table auth.users (id uuid primary key, email text);
    insert into auth.users (id, email) values
      ('10000000-0000-0000-0000-000000000001', 'sales@vyra.test'),
      ('10000000-0000-0000-0000-000000000002', 'manager@vyra.test');
  `)

  /**
   * And now that there is one, re-run the migration that reads it.
   *
   * 0028 installs the email lookup conditionally, because PostgreSQL parses a
   * SQL function's body at creation and naming auth.users where the schema does
   * not exist fails every migration run. On the first pass above it took the
   * empty branch; here it takes the real one, which is what production has.
   */
  await db.exec(readFileSync(join(migrationsDir, '0028_member_emails.sql'), 'utf8'))

  await db.exec(`
    insert into operators (id, name) values ('${OPERATOR}', 'Vyra Pilot'), ('${RIVAL}', 'Rival');
    insert into whatsapp_accounts (id, operator_id, provider_account_id, phone_number_id)
    values ('33333333-3333-3333-3333-333333333333', '${OPERATOR}', 'waba', '111');
    insert into contacts (id, operator_id, channel_identifier)
    values ('55555555-5555-5555-5555-555555555555', '${OPERATOR}', '971500000001');
    insert into conversations (id, operator_id, contact_id, whatsapp_account_id)
    values ('${CONVERSATION}', '${OPERATOR}', '55555555-5555-5555-5555-555555555555',
            '33333333-3333-3333-3333-333333333333');
    insert into memberships (id, operator_id, user_id, role, display_name) values
      ('${SALES}', '${OPERATOR}', '10000000-0000-0000-0000-000000000001', 'salesperson', 'Ahmed'),
      ('${MANAGER}', '${OPERATOR}', '10000000-0000-0000-0000-000000000002', 'manager', 'Sara'),
      ('${RIVAL_MEMBER}', '${RIVAL}', '10000000-0000-0000-0000-000000000003', 'salesperson', 'Omar');
  `)
})

describe('internal notes', () => {
  it('stores a note against the conversation', async () => {
    const { noteId } = await addNote(run, {
      operatorId: OPERATOR, conversationId: CONVERSATION,
      membershipId: SALES, body: 'Customer mentioned a wedding on the 20th.',
    })
    expect(noteId).toBeTruthy()

    const notes = await listNotes(run, OPERATOR, CONVERSATION)
    expect(notes).toHaveLength(1)
    expect(notes[0]).toMatchObject({
      body: 'Customer mentioned a wedding on the 20th.', authorMembershipId: SALES,
    })
  })

  /**
   * The property this table exists for. The dispatcher only ever reads
   * `messages`, so a note cannot be sent to a customer by a forgotten filter.
   */
  it('never creates anything the dispatcher could send', async () => {
    await addNote(run, {
      operatorId: OPERATOR, conversationId: CONVERSATION, membershipId: SALES, body: 'Do not tell them this',
    })
    const sendable = await run(
      `select count(*)::int as n from messages where direction = 'outbound'`, [],
    )
    expect(sendable[0]!['n']).toBe(0)

    const outbox = await run(`select count(*)::int as n from outbox`, [])
    expect(outbox[0]!['n']).toBe(0)
  })

  it('refuses a note on another operator conversation', async () => {
    const { noteId } = await addNote(run, {
      operatorId: RIVAL, conversationId: CONVERSATION, membershipId: RIVAL_MEMBER, body: 'peeking',
    })
    expect(noteId).toBeNull()
    expect(await listNotes(run, OPERATOR, CONVERSATION)).toHaveLength(0)
  })

  it('does not leak notes across operators', async () => {
    await addNote(run, { operatorId: OPERATOR, conversationId: CONVERSATION, membershipId: SALES, body: 'ours' })
    expect(await listNotes(run, RIVAL, CONVERSATION)).toHaveLength(0)
  })
})

describe('assignment', () => {
  const ownerOf = async () =>
    (await run('select owner_membership_id, handler_mode from conversations where id = $1', [CONVERSATION]))[0]!

  it('assigns and unassigns', async () => {
    expect(await assignConversation(run, {
      operatorId: OPERATOR, conversationId: CONVERSATION,
      assigneeMembershipId: SALES, actorMembershipId: MANAGER,
    })).toEqual({ assigned: true })
    expect((await ownerOf())['owner_membership_id']).toBe(SALES)

    await assignConversation(run, {
      operatorId: OPERATOR, conversationId: CONVERSATION,
      assigneeMembershipId: null, actorMembershipId: MANAGER,
    })
    expect((await ownerOf())['owner_membership_id']).toBeNull()
  })

  /**
   * Assignment and reply ownership are separate fields for separate reasons.
   * A manager tidying a queue must not silently start or stop automation.
   */
  it('does not change who owns the next reply', async () => {
    await assignConversation(run, {
      operatorId: OPERATOR, conversationId: CONVERSATION,
      assigneeMembershipId: SALES, actorMembershipId: MANAGER,
    })
    expect((await ownerOf())['handler_mode']).toBe('ai')
  })

  it('refuses an assignee from another operator', async () => {
    const result = await assignConversation(run, {
      operatorId: OPERATOR, conversationId: CONVERSATION,
      assigneeMembershipId: RIVAL_MEMBER, actorMembershipId: MANAGER,
    })
    expect(result).toEqual({ assigned: false })
    expect((await ownerOf())['owner_membership_id']).toBeNull()
  })

  it('refuses to assign another operator conversation', async () => {
    expect(await assignConversation(run, {
      operatorId: RIVAL, conversationId: CONVERSATION,
      assigneeMembershipId: RIVAL_MEMBER, actorMembershipId: RIVAL_MEMBER,
    })).toEqual({ assigned: false })
  })

  it('records who reassigned what', async () => {
    await assignConversation(run, {
      operatorId: OPERATOR, conversationId: CONVERSATION,
      assigneeMembershipId: SALES, actorMembershipId: MANAGER,
    })
    const rows = await run(`select action, actor_id from audit_events`, [])
    expect(rows[0]).toMatchObject({ action: 'conversation.assigned', actor_id: MANAGER })
  })
})

describe('priority', () => {
  const priorityOf = async () =>
    (await run('select priority from conversations where id = $1', [CONVERSATION]))[0]!['priority']

  it('changes priority and records it', async () => {
    expect(await setPriority(run, {
      operatorId: OPERATOR, conversationId: CONVERSATION, priority: 'urgent', actorMembershipId: SALES,
    })).toEqual({ changed: true })
    expect(await priorityOf()).toBe('urgent')
  })

  it('rejects a value that is not a priority rather than erroring', async () => {
    expect(await setPriority(run, {
      operatorId: OPERATOR, conversationId: CONVERSATION, priority: 'extremely urgent', actorMembershipId: SALES,
    })).toEqual({ changed: false })
    expect(await priorityOf()).toBe('normal')
  })

  it('refuses another operator conversation', async () => {
    expect(await setPriority(run, {
      operatorId: RIVAL, conversationId: CONVERSATION, priority: 'urgent', actorMembershipId: RIVAL_MEMBER,
    })).toEqual({ changed: false })
  })
})

describe('listing colleagues', () => {
  /**
   * Emails come from a security-definer function that only answers for people
   * who share an operator with the caller, so the caller has to be somebody.
   * In the application that is the signed-in user; here it is said outright.
   */
  const asSignedIn = (userId: string) =>
    run(`select set_config('app.current_user_id', $1, false)`, [userId])

  it('returns only this operator active members, with emails', async () => {
    await asSignedIn('10000000-0000-0000-0000-000000000001')

    const members = await listMembers(run, OPERATOR)
    expect(members.map((m) => m.email).sort()).toEqual(['manager@vyra.test', 'sales@vyra.test'])
  })

  /**
   * Nobody identified, no emails — and the rest of the row still comes back.
   * That is the whole point of the left join: a missing email must not take
   * the colleague with it.
   */
  it('still lists colleagues when nobody is identified, without their emails', async () => {
    const members = await listMembers(run, OPERATOR)
    expect(members).toHaveLength(2)
    expect(members.map((m) => m.email)).toEqual([null, null])
  })

  it('excludes deactivated members', async () => {
    await run(`update memberships set active = false where id = $1`, [SALES])
    expect((await listMembers(run, OPERATOR)).map((m) => m.membershipId)).toEqual([MANAGER])
  })

  it('never returns another operator staff', async () => {
    const members = await listMembers(run, OPERATOR)
    expect(members.some((m) => m.membershipId === RIVAL_MEMBER)).toBe(false)
  })
})

describe('notes and replies stay separate', () => {
  it('a queued reply is a message and a note is not', async () => {
    await queueOutboundText(run, {
      conversationId: CONVERSATION, operatorId: OPERATOR,
      body: 'A real reply', idempotencyKey: 'staff-1', sentByMembershipId: SALES,
    })
    await addNote(run, {
      operatorId: OPERATOR, conversationId: CONVERSATION, membershipId: SALES, body: 'A private thought',
    })

    // Signed, because it came from a person. The note is not a message at all.
    const bodies = (await run(`select body from messages`, [])).map((r) => r['body'])
    expect(bodies).toEqual(['A real reply\n— Ahmed'])
  })
})

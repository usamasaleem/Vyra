import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { beforeEach, describe, expect, it } from 'vitest'

/**
 * Build plan step 14 — proving row-level security actually refuses things.
 *
 * Policies that are never exercised are decoration. These tests enter the
 * restricted role exactly as a request does, then try to reach another
 * operator's data by every route the application offers.
 */

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations')
const OP_A = '11111111-1111-1111-1111-111111111111'
const OP_B = '22222222-2222-2222-2222-222222222222'
const USER_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const USER_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
const CONV_A = 'cccccccc-cccc-cccc-cccc-cccccccccccc'
const CONV_B = 'dddddddd-dddd-dddd-dddd-dddddddddddd'

let db: PGlite

/** Runs a query the way a request does: restricted role, identified user. */
async function asUser(userId: string | null, sql: string, params: unknown[] = []) {
  await db.exec('begin')
  try {
    await db.exec(`set local role vyra_app`)
    await db.query(`select set_config('app.current_user_id', $1, true)`, [userId])
    const result = await db.query(sql, params)
    await db.exec('commit')
    return result.rows as Array<Record<string, unknown>>
  } catch (error) {
    await db.exec('rollback')
    throw error
  }
}

beforeEach(async () => {
  db = await PGlite.create()
  for (const f of readdirSync(migrationsDir).filter((n) => n.endsWith('.sql')).sort()) {
    await db.exec(readFileSync(join(migrationsDir, f), 'utf8'))
  }
  // Seeded as the privileged role, exactly as the worker and migrations do.
  await db.exec(`
    insert into operators (id, name) values ('${OP_A}', 'Vyra Pilot'), ('${OP_B}', 'Rival Rentals');
    insert into memberships (operator_id, user_id, role) values
      ('${OP_A}', '${USER_A}', 'admin'), ('${OP_B}', '${USER_B}', 'admin');
    insert into whatsapp_accounts (id, operator_id, provider_account_id, phone_number_id) values
      ('e1111111-1111-1111-1111-111111111111', '${OP_A}', 'waba-a', '111'),
      ('e2222222-2222-2222-2222-222222222222', '${OP_B}', 'waba-b', '222');
    insert into contacts (id, operator_id, channel_identifier) values
      ('f1111111-1111-1111-1111-111111111111', '${OP_A}', '971500000001'),
      ('f2222222-2222-2222-2222-222222222222', '${OP_B}', '971500000002');
    insert into conversations (id, operator_id, contact_id, whatsapp_account_id) values
      ('${CONV_A}', '${OP_A}', 'f1111111-1111-1111-1111-111111111111', 'e1111111-1111-1111-1111-111111111111'),
      ('${CONV_B}', '${OP_B}', 'f2222222-2222-2222-2222-222222222222', 'e2222222-2222-2222-2222-222222222222');
    insert into messages (operator_id, conversation_id, direction, kind, body, provider_id) values
      ('${OP_A}', '${CONV_A}', 'inbound', 'text', 'pilot customer message', 'wamid.A'),
      ('${OP_B}', '${CONV_B}', 'inbound', 'text', 'RIVAL SECRET', 'wamid.B');
  `)
})

describe('a signed-in user sees only their own operator', () => {
  it('lists only their conversations', async () => {
    const rows = await asUser(USER_A, 'select id from conversations')
    expect(rows.map((r) => r['id'])).toEqual([CONV_A])
  })

  it('lists only their messages', async () => {
    const rows = await asUser(USER_A, 'select body from messages')
    expect(rows.map((r) => r['body'])).toEqual(['pilot customer message'])
  })

  it('sees only their own operator record', async () => {
    const rows = await asUser(USER_A, 'select name from operators')
    expect(rows.map((r) => r['name'])).toEqual(['Vyra Pilot'])
  })

  it('cannot see another operator staff list', async () => {
    const rows = await asUser(USER_A, 'select user_id from memberships')
    expect(rows.map((r) => r['user_id'])).toEqual([USER_A])
  })
})

describe('a query that forgets its operator filter still cannot leak', () => {
  /** The exact mistake this layer exists to catch. */
  it('returns nothing extra for an unscoped select', async () => {
    const rows = await asUser(USER_A, 'select body from messages order by created_at')
    expect(rows).toHaveLength(1)
    expect(JSON.stringify(rows)).not.toContain('RIVAL SECRET')
  })

  it('refuses a direct read of another operator conversation by id', async () => {
    const rows = await asUser(USER_A, 'select id from conversations where id = $1', [CONV_B])
    expect(rows).toEqual([])
  })

  it('refuses a join that reaches across operators', async () => {
    const rows = await asUser(
      USER_A,
      `select m.body from messages m join conversations v on v.id = m.conversation_id`,
    )
    expect(rows.map((r) => r['body'])).toEqual(['pilot customer message'])
  })
})

describe('writes are scoped too', () => {
  it('refuses to insert a message into another operator conversation', async () => {
    await expect(
      asUser(USER_A, `insert into messages (operator_id, conversation_id, direction, kind, body)
                      values ($1, $2, 'outbound', 'text', 'injected')`, [OP_B, CONV_B]),
    ).rejects.toThrow(/row-level security/i)
  })

  /**
   * Moving a row you can see into an operator you cannot is caught by the
   * WITH CHECK half of the policy, which raises rather than quietly matching
   * nothing. Loud is the right outcome for an attempted relabel.
   */
  it('refuses to relabel a row into another operator', async () => {
    await expect(
      asUser(USER_A, `update conversations set operator_id = $1 returning id`, [OP_B]),
    ).rejects.toThrow(/row-level security/i)
  })

  it('allows a legitimate write to their own operator', async () => {
    const rows = await asUser(
      USER_A,
      `insert into conversation_notes (operator_id, conversation_id, body)
       values ($1, $2, 'a note') returning id`,
      [OP_A, CONV_A],
    )
    expect(rows).toHaveLength(1)
  })
})

describe('fail closed', () => {
  /** No identified user means no data, not all data. */
  it('shows nothing when no user id is set', async () => {
    expect(await asUser(null, 'select id from conversations')).toEqual([])
    expect(await asUser(null, 'select body from messages')).toEqual([])
  })

  it('shows nothing for a user who holds no membership', async () => {
    const stranger = '99999999-9999-9999-9999-999999999999'
    expect(await asUser(stranger, 'select id from conversations')).toEqual([])
  })

  it('shows nothing once a membership is deactivated', async () => {
    await db.exec(`update memberships set active = false where user_id = '${USER_A}'`)
    expect(await asUser(USER_A, 'select id from conversations')).toEqual([])
  })
})

describe('the privileged role still works, because the worker needs it', () => {
  it('sees everything when not in the restricted role', async () => {
    const rows = (await db.query('select body from messages order by created_at')).rows as Array<Record<string, unknown>>
    expect(rows).toHaveLength(2)
  })
})

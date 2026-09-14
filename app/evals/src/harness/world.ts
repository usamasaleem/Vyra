import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { ensureEnquiry } from '@vyra/db'
import type { QueryRunner, Transactor } from '@vyra/db'
import type { ToolContext } from '@vyra/agent'

/**
 * A disposable operator for the comparison to run against.
 *
 * PGlite rather than a mock, for the reason this repo has learned twice: a
 * mocked query passes while the SQL behind it references a column that does not
 * exist. The tools write real rows through real migrations, so "did it record
 * the vehicle" is answered by looking in `field_evidence` rather than by
 * trusting that the call was made.
 *
 * One database, a fresh conversation per case. Creating a PGlite instance takes
 * about a second, and twenty-eight cases across several models would spend
 * minutes on setup; a new conversation and enquiry per case gives the same
 * isolation for the state that matters, since nothing in a turn reaches beyond
 * its own conversation.
 *
 * Nothing is published into `knowledge_entries` on purpose. That is the true
 * state of the pilot today — the six operator questions are still outstanding —
 * so a policy question has no approved answer, and the correct behaviour is to
 * say so. A comparison run against seeded answers would be measuring a system
 * that does not exist yet.
 */

export type EvalWorld = {
  operatorId: string
  contextFor: (caseId: string, customerMessages: string[]) => Promise<ToolContext>
  /** Fields this case's turn wrote, read back from the database. */
  recordedFields: (ctx: ToolContext) => Promise<string[]>
  run: QueryRunner
  transact: Transactor
  close: () => Promise<void>
}

const OPERATOR = '11111111-1111-1111-1111-111111111111'
const ACCOUNT = '33333333-3333-3333-3333-333333333333'
const TIMEZONE = 'Asia/Dubai'

/** Fixed, so "tomorrow" resolves to the same date on every run and every model. */
export const EVAL_NOW = new Date('2026-09-14T08:00:00Z')

export async function createEvalWorld(options: { migrationsDir?: string } = {}): Promise<EvalWorld> {
  const migrationsDir = options.migrationsDir
    ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'db', 'migrations')

  const db = await PGlite.create()
  const run: QueryRunner = async (text, params) =>
    (await db.query(text, params)).rows as Array<Record<string, unknown>>
  const transact: Transactor = async (fn) => {
    let out: unknown
    await db.transaction(async (tx) => {
      out = await fn(async (text, params) =>
        (await tx.query(text, params)).rows as Array<Record<string, unknown>>)
    })
    return out as never
  }

  for (const file of readdirSync(migrationsDir).filter((n) => n.endsWith('.sql')).sort()) {
    await db.exec(readFileSync(join(migrationsDir, file), 'utf8'))
  }
  await db.exec(`
    insert into operators (id, name, timezone) values ('${OPERATOR}', 'Eval Operator', '${TIMEZONE}');
    insert into whatsapp_accounts (id, operator_id, provider_account_id, phone_number_id)
    values ('${ACCOUNT}', '${OPERATOR}', 'waba-eval', '111');
  `)

  let seq = 0

  async function contextFor(caseId: string, customerMessages: string[]): Promise<ToolContext> {
    seq++
    const suffix = String(seq).padStart(12, '0')
    const contactId = `55555555-5555-5555-5555-${suffix}`
    const conversationId = `66666666-6666-6666-6666-${suffix}`

    await run(
      `insert into contacts (id, operator_id, channel_identifier) values ($1, $2, $3)`,
      [contactId, OPERATOR, `9715000${suffix.slice(-5)}`],
    )
    await run(
      `insert into conversations (id, operator_id, contact_id, whatsapp_account_id)
       values ($1, $2, $3, $4)`,
      [conversationId, OPERATOR, contactId, ACCOUNT],
    )

    // Every customer message is stored, because the tools attribute evidence to
    // a real message id and a turn with several messages has several of them.
    let lastMessageId = ''
    for (const [index, body] of customerMessages.entries()) {
      const rows = await run(
        `insert into messages (operator_id, conversation_id, direction, kind, body, provider_id)
         values ($1, $2, 'inbound', 'text', $3, $4) returning id`,
        [OPERATOR, conversationId, body, `wamid.${caseId}.${index}`],
      )
      lastMessageId = rows[0]!['id'] as string
    }

    return {
      operatorId: OPERATOR,
      conversationId,
      enquiryId: (await ensureEnquiry(run, OPERATOR, conversationId))!,
      messageId: lastMessageId,
      timezone: TIMEZONE,
      now: EVAL_NOW,
      run,
      transact,
    }
  }

  async function recordedFields(ctx: ToolContext): Promise<string[]> {
    const rows = await run(
      `select field::text as field from field_evidence
       where enquiry_id = $1 and operator_id = $2 and superseded_at is null`,
      [ctx.enquiryId, ctx.operatorId],
    )
    return rows.map((r) => r['field'] as string)
  }

  return {
    operatorId: OPERATOR,
    contextFor,
    recordedFields,
    run,
    transact,
    close: () => db.close(),
  }
}

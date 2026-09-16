import { createClient, type Sql, type Transactor } from '@vyra/db'
import type { QueryRunner } from './whatsapp/ingest'
import { serverEnv } from './env'

/**
 * One pool per process, cached across hot reloads.
 *
 * Next recreates modules on every edit in development; without this the pool
 * count climbs until Postgres refuses new connections.
 */
const globalForDb = globalThis as unknown as { __vyraSql?: Sql }

function sqlClient(): Sql {
  globalForDb.__vyraSql ??= createClient(serverEnv().DATABASE_URL).sql
  return globalForDb.__vyraSql
}

/**
 * Privileged. Bypasses row-level security entirely.
 *
 * Reserved for the three callers that have no signed-in user to be scoped as:
 * the Meta webhook, the public fleet-photo endpoint, and the membership lookup
 * in lib/auth that establishes who the user is in the first place. Everything
 * a staff member causes goes through `actorRunner` instead.
 *
 * Named deliberately plainly rather than something reassuring. Until now every
 * page in the inbox used this, which meant the policies written in migration
 * 0005 were installed, tested, and enforcing nothing: the connection role is
 * the Supabase superuser, and a superuser is exempt from RLS. The tests passed
 * because PGlite runs them the way production was supposed to work.
 */
export function queryRunner(): QueryRunner {
  const sql = sqlClient()
  return async (text, params) =>
    (await sql.unsafe(text, params as never[])) as unknown as Array<Record<string, unknown>>
}

/**
 * A transaction, for the queries that need several statements to agree.
 *
 * The inbox has managed without one until now because every action it performs
 * is a single statement, which is atomic on its own. Publishing an operator
 * answer is not: the current version is closed and the new one opened, and a
 * failure between them would leave a topic with no live answer at all.
 */
export function transactor(): Transactor {
  const sql = sqlClient()
  return ((fn: (tx: QueryRunner) => Promise<unknown>) =>
    sql.begin((tx) =>
      fn(async (text, params) =>
        (await tx.unsafe(text, params as never[])) as unknown as Array<Record<string, unknown>>),
    )) as Transactor
}


/**
 * Build plan step 14, the half that was missing — the request actually runs
 * as the restricted role.
 *
 * Migration 0005 describes this exact shape and explains why it is a SET ROLE
 * rather than a second connection string: one password to rotate instead of
 * two. What it describes had never been written, so `vyra_app` existed, held
 * its grants, and was never entered by anything.
 *
 *   begin;
 *   select set_config('app.current_user_id', $1, true);  -- who is asking
 *   set local role vyra_app;                             -- nobypassrls
 *   ... the statement ...
 *   commit;                          -- both revert, whatever happened
 *
 * The setting is written before the role is entered. Either order works —
 * a custom GUC is settable by any role — and this one is chosen so that
 * identifying the user never depends on what the restricted role happens to
 * be permitted to do.
 *
 * Both revert on commit AND on rollback, which is what makes this safe on a
 * pooled connection: a failed statement cannot leave the next request holding
 * someone else's identity or a role it did not ask for.
 *
 * The cost is one transaction per statement where there was none. Worth it:
 * the alternative is a `where operator_id` clause being the only thing between
 * two operators' customers, forever, with no second line.
 */
async function enterRestrictedRole(tx: QueryRunner, userId: string): Promise<void> {
  await tx(`select set_config('app.current_user_id', $1, true)`, [userId])
  await tx(`set local role vyra_app`, [])
}

/** What a signed-in staff member's request runs as. */
export function actorRunner(actor: { userId: string }): QueryRunner {
  const sql = sqlClient()
  return async (text, params) =>
    (await sql.begin(async (raw) => {
      const tx: QueryRunner = async (t, p) =>
        (await raw.unsafe(t, (p ?? []) as never[])) as unknown as Array<Record<string, unknown>>
      await enterRestrictedRole(tx, actor.userId)
      return tx(text, params)
    })) as unknown as Array<Record<string, unknown>>
}

/**
 * The same, for the actions that need several statements to agree.
 *
 * One transaction for the role and the work together, rather than a restricted
 * transaction per statement: publishing an answer closes one version and opens
 * the next, and those must not be able to disagree.
 */
export function actorTransactor(actor: { userId: string }): Transactor {
  const sql = sqlClient()
  return ((fn: (tx: QueryRunner) => Promise<unknown>) =>
    sql.begin(async (raw) => {
      const tx: QueryRunner = async (t, p) =>
        (await raw.unsafe(t, (p ?? []) as never[])) as unknown as Array<Record<string, unknown>>
      await enterRestrictedRole(tx, actor.userId)
      return fn(tx)
    })) as Transactor
}

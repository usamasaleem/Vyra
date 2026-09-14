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

/** Adapts postgres.js to the driver contract the ingest statements expect. */
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

import { createClient, type Sql } from '@vyra/db'
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

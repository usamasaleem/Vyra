import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema/index.js'

export type Database = ReturnType<typeof createDatabase>

/**
 * The worker connects with a privileged role and therefore bypasses row-level
 * security. Section 18.7: every worker query must scope by operator_id
 * explicitly — RLS protects the browser path, not this one.
 */
export function createDatabase(connectionString: string, options?: { max?: number }) {
  const sql = postgres(connectionString, {
    max: options?.max ?? 10,
    prepare: false,
  })
  return drizzle(sql, { schema, casing: 'snake_case' })
}

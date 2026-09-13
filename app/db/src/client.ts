import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema/index.js'

export type Sql = ReturnType<typeof postgres>
export type Database = ReturnType<typeof drizzle<typeof schema>>

/**
 * The worker connects with a privileged role and therefore bypasses row-level
 * security. Section 18.7: every worker query must scope by operator_id
 * explicitly — RLS protects the browser path, not this one.
 */
export function createClient(connectionString: string, options?: { max?: number }) {
  const sql = postgres(connectionString, {
    max: options?.max ?? 5,
    // Required for transaction-mode pooling, harmless on a direct connection.
    prepare: false,
  })
  return { sql, db: drizzle(sql, { schema, casing: 'snake_case' }) }
}

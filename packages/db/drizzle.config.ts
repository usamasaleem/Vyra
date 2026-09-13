import { defineConfig } from 'drizzle-kit'

const url = process.env.DATABASE_URL

export default defineConfig({
  schema: './src/schema/index.ts',
  out: './migrations',
  dialect: 'postgresql',
  casing: 'snake_case',
  dbCredentials: { url: url ?? '' },
  /** Supabase manages these schemas; drizzle-kit must not try to. */
  schemaFilter: ['public'],
  verbose: true,
  strict: true,
})

/**
 * The driver contract shared by every query in this repository.
 *
 * Deliberately two lines. postgres.js satisfies it in production and PGlite
 * satisfies it in tests, so the statement exercised by a test is the statement
 * that runs in production — not a paraphrase of it.
 */
export type QueryRunner = (
  text: string,
  params: unknown[],
) => Promise<Array<Record<string, unknown>>>

/** Runs a function inside a database transaction. */
export type Transactor = <T>(fn: (tx: QueryRunner) => Promise<T>) => Promise<T>

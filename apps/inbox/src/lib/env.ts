import { parseServerEnv, type ServerEnv } from '@vyra/contracts'

let cached: ServerEnv | undefined

/**
 * Resolved lazily and memoised.
 *
 * Not at module scope: Next evaluates route modules during the production
 * build, where these variables are absent, and a build must not fail for the
 * lack of a runtime secret.
 */
export function serverEnv(): ServerEnv {
  cached ??= parseServerEnv()
  return cached
}

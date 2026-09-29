/**
 * How long the relay waits between looks at the outbox.
 *
 * It looked every 250 ms, all day and all night. Each look is a transaction
 * to the database, about 800 bytes going out, so a quiet worker on Render sent
 * about 11.7 MB an hour: 3.93 GB by mid-September against the Hobby plan's
 * 5 GB, with the hourly graph a flat line because nobody's traffic was in it.
 *
 * A message being handled is not quiet. The turn takes several seconds, and
 * when it ends its reply lands in the outbox and has to be relayed to be sent,
 * so the fast pace holds for a minute after anything was claimed. After that
 * the pace drops in two steps. Only the first message after a quiet spell
 * pays for it, and by at most two seconds.
 */
export const BUSY_INTERVAL_MS = 250
export const QUIET_INTERVAL_MS = 1_000
export const IDLE_INTERVAL_MS = 2_000

/** How long after the last claimed work the relay keeps looking quickly. */
export const BUSY_WINDOW_MS = 60_000
/** How long after it the relay looks once a second before settling. */
export const QUIET_WINDOW_MS = 5 * 60_000

export function relayDelayMs(sinceLastWorkMs: number): number {
  if (sinceLastWorkMs < BUSY_WINDOW_MS) return BUSY_INTERVAL_MS
  if (sinceLastWorkMs < QUIET_WINDOW_MS) return QUIET_INTERVAL_MS
  return IDLE_INTERVAL_MS
}

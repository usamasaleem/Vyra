import { parseServerEnv } from '@vyra/contracts'
import { createClient } from '@vyra/db'
import { publishToGraphileWorker, relayOnce, type Transactor } from './relay.js'

const env = parseServerEnv()
const { sql } = createClient(env.DATABASE_URL, { max: 4 })

const log = (fields: Record<string, unknown>) =>
  console.log(JSON.stringify({ at: new Date().toISOString(), ...fields }))

/** Adapts postgres.js transactions to the relay's driver contract. */
const transact: Transactor = (fn) =>
  sql.begin((tx) =>
    fn(async (text, params) => (await tx.unsafe(text, params as never[])) as never),
  ) as never

/**
 * Poll interval when the outbox was empty last pass.
 *
 * A message already cost ~2 seconds reaching us through Meta, so 250ms of
 * relay latency is not what a customer notices. When work is found we loop
 * immediately instead of waiting, so a backlog drains at full speed rather
 * than one batch per tick.
 */
const IDLE_INTERVAL_MS = 250

let running = true
let inFlight: Promise<unknown> = Promise.resolve()

async function relayLoop(): Promise<void> {
  while (running) {
    try {
      inFlight = relayOnce(transact, publishToGraphileWorker)
      const result = (await inFlight) as Awaited<ReturnType<typeof relayOnce>>

      if (result.claimed > 0) {
        log({ event: 'relay.pass', ...result })
        // Work found: go straight round again.
        continue
      }
    } catch (error) {
      // The loop itself must survive a database blip. Individual row failures
      // are already handled inside relayOnce; this catches the claim query.
      log({
        event: 'relay.error',
        error: error instanceof Error ? error.message : String(error),
      })
    }
    await new Promise((resolve) => setTimeout(resolve, IDLE_INTERVAL_MS))
  }
}

async function shutdown(signal: string): Promise<void> {
  log({ event: 'worker.shutdown', signal })
  running = false
  // Let the pass in flight finish so a claimed row is never abandoned
  // mid-transaction.
  await inFlight.catch(() => {})
  await sql.end({ timeout: 5 })
  process.exit(0)
}

process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))

log({
  event: 'worker.start',
  node: process.version,
  nodeEnv: env.NODE_ENV,
  aiSendingEnabled: env.AI_SENDING_ENABLED,
  relay: 'running',
  taskList: 'not registered yet — build plan step 10',
})

await relayLoop()

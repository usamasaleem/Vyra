import { parseServerEnv } from '@vyra/contracts'
import { createClient } from '@vyra/db'
import { run as runWorker, type Runner } from 'graphile-worker'
import { dispatchMessage } from './dispatcher.js'
import { reapStaleDispatching } from './failures.js'
import { publishToGraphileWorker, relayOnce, type QueryRunner, type Transactor } from './relay.js'
import { processInboundMessage } from './tasks/process-inbound-message.js'
import { createWhatsAppClient } from './whatsapp/client.js'

const env = parseServerEnv()
const { sql } = createClient(env.DATABASE_URL, { max: 4 })

const log = (fields: Record<string, unknown>) =>
  console.log(JSON.stringify({ at: new Date().toISOString(), ...fields }))

const query: QueryRunner = async (text, params) =>
  (await sql.unsafe(text, params as never[])) as never

const transact: Transactor = (fn) =>
  sql.begin((tx) =>
    fn(async (text, params) => (await tx.unsafe(text, params as never[])) as never),
  ) as never

/**
 * The one client that talks to Meta. Section 18.3: the dispatcher is the only
 * component that sends, including for messages a salesperson typed by hand.
 */
const whatsapp = createWhatsAppClient({
  apiVersion: env.WHATSAPP_API_VERSION,
  phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID,
  accessToken: env.WHATSAPP_ACCESS_TOKEN,
})

const DISPATCHER_AVAILABLE = true

const IDLE_INTERVAL_MS = 250

/**
 * A worker killed between claiming a send and hearing back from Meta leaves
 * the row in `dispatching` forever. Sweep those into `unknown` so a person can
 * see them — never back to `pending`, because we cannot tell whether Meta
 * accepted it, and guessing risks sending the customer the same message twice.
 */
const REAP_INTERVAL_MS = 60_000
let lastReapAt = 0

let running = true
let relayInFlight: Promise<unknown> = Promise.resolve()

async function relayLoop(): Promise<void> {
  while (running) {
    try {
      relayInFlight = relayOnce(transact, publishToGraphileWorker)
      const result = (await relayInFlight) as Awaited<ReturnType<typeof relayOnce>>
      if (result.claimed > 0) {
        log({ event: 'relay.pass', ...result })
        continue
      }

      if (Date.now() - lastReapAt > REAP_INTERVAL_MS) {
        lastReapAt = Date.now()
        const { reaped } = await reapStaleDispatching(query)
        if (reaped > 0) log({ event: 'dispatch.reaped', count: reaped })
      }
    } catch (error) {
      log({ event: 'relay.error', error: messageOf(error) })
    }
    await new Promise((resolve) => setTimeout(resolve, IDLE_INTERVAL_MS))
  }
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

const runner: Runner = await runWorker({
  connectionString: env.DATABASE_URL,
  // Per-conversation ordering comes from the queue name on each job, not from
  // this number. Section 18.10 is explicit that a global concurrency setting
  // does not serialise a conversation.
  concurrency: 5,
  noHandleSignals: true,

  /**
   * How quickly a lock held by a dead worker is released.
   *
   * This matters more here than in most queues because jobs are serialised per
   * conversation. A worker that dies holding a job does not just delay that
   * job — it blocks every later message from the same customer behind it. On
   * the default schedule that conversation is stuck for hours, and the symptom
   * is silence rather than an error.
   *
   * Observed in the pilot: a worker died after dispatching, and the next
   * inbound message for that conversation sat unclaimed for over an hour.
   *
   * A minute of delay after a crash is acceptable; an hour is not.
   */
  minResetLockedInterval: 30_000,
  maxResetLockedInterval: 60_000,

  /**
   * Keep the worker's own pool small. It runs beside the postgres.js pool this
   * process already opens, and both hold real backend connections on the
   * session pooler.
   */
  maxPoolSize: 4,
  taskList: {
    dispatch_outbound: async (payload, helpers) => {
      const messageId = (payload as { message_id?: unknown } | null)?.message_id
      if (typeof messageId !== 'string') {
        log({ event: 'dispatch.skipped', jobId: helpers.job.id, reason: 'no_message_id' })
        return
      }

      const result = await dispatchMessage(query, whatsapp, messageId)
      log({ event: 'dispatch.result', jobId: helpers.job.id, messageId, ...result })

      // Only a retryable failure should make graphile-worker try again. An
      // unknown outcome must not be retried at all: Meta may have delivered it.
      if (result.outcome === 'failed' && result.retryable) {
        throw new Error(`retryable send failure: ${result.error}`)
      }
    },

    process_inbound_message: async (payload, helpers) => {
      const result = await processInboundMessage(
        query,
        (payload ?? {}) as Record<string, unknown>,
        {
          systemAiSendingEnabled: env.AI_SENDING_ENABLED,
          dispatcherAvailable: DISPATCHER_AVAILABLE,
        },
      )

      if (result.outcome !== 'processed') {
        // Not an error: a job whose subject is gone is finished, and a
        // mismatched operator id is a bug to see rather than retry.
        log({ event: 'task.skipped', jobId: helpers.job.id, outcome: result.outcome })
        return
      }

      const { context, handling } = result
      log({
        event: 'task.processed',
        jobId: helpers.job.id,
        operator: context.operator.name,
        conversation: context.conversation.id,
        revision: context.conversation.revision,
        handlerMode: context.conversation.handlerMode,
        salesStage: context.conversation.salesStage,
        contact: context.contact.channelIdentifier,
        messageKind: context.message.kind,
        body: context.message.body,
        historyLength: context.recentMessages.length,
        action: handling.action,
        reason: handling.reason,
      })
    },
  },
})

/**
 * Shutting down without abandoning work.
 *
 * A deploy is the ordinary case, not a rare one: every push to main redeploys
 * this service, so the worker is stopped and restarted constantly during
 * development. If a job is in flight when that happens and the process exits
 * before graphile-worker releases it, the job stays locked — and because jobs
 * are serialised per conversation, that blocks one customer until the lock
 * recovery sweep catches it.
 *
 * So the sequence is logged at every step. The previous version swallowed
 * errors from stop() and exited regardless, which meant a shutdown that failed
 * to release its jobs looked exactly like one that succeeded.
 */
const SHUTDOWN_BUDGET_MS = 20_000

async function shutdown(signal: string): Promise<void> {
  const startedAt = Date.now()
  log({ event: 'worker.shutdown.begin', signal })
  running = false

  const withinBudget = async <T>(label: string, work: Promise<T>): Promise<void> => {
    const remaining = SHUTDOWN_BUDGET_MS - (Date.now() - startedAt)
    let timer: NodeJS.Timeout | undefined
    const expired = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), Math.max(remaining, 0))
    })
    try {
      const outcome = await Promise.race([work.then(() => 'done' as const), expired])
      log({ event: 'worker.shutdown.step', step: label, outcome, ms: Date.now() - startedAt })
    } catch (error) {
      // Never silent. A shutdown that failed to release its jobs must not look
      // like one that succeeded.
      log({ event: 'worker.shutdown.step', step: label, outcome: 'error', error: messageOf(error) })
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  await withinBudget('relay', relayInFlight)
  // stop() is graphile-worker's clean shutdown: it waits for running jobs and
  // releases their locks. Worth the wait — the alternative is a blocked
  // conversation.
  await withinBudget('jobs', runner.stop('deploy or restart'))
  await withinBudget('database', sql.end({ timeout: 5 }))

  log({ event: 'worker.shutdown.complete', signal, ms: Date.now() - startedAt })
  process.exit(0)
}

process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))

log({
  event: 'worker.start',
  node: process.version,
  nodeEnv: env.NODE_ENV,
  aiSendingEnabled: env.AI_SENDING_ENABLED,
  dispatcherAvailable: DISPATCHER_AVAILABLE,
  tasks: ['process_inbound_message', 'dispatch_outbound'],
})

await relayLoop()

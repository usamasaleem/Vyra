import { parseServerEnv } from '@vyra/contracts'
import { createClient } from '@vyra/db'
import { run as runWorker, type Runner } from 'graphile-worker'
import { dispatchMessage } from './dispatcher.js'
import { releaseAbandonedJobs } from './abandoned-jobs.js'
import { reapStaleDispatching } from './failures.js'
import { escalateOverdueHandoffs } from '@vyra/db'
import { publishToGraphileWorker, relayOnce, type QueryRunner, type Transactor } from './relay.js'
import { processInboundMessage } from './tasks/process-inbound-message.js'
import { createWhatsAppClient } from './whatsapp/client.js'
import { openaiModel, type ModelAdapter } from '@vyra/agent'
import { handleNonTextMessage, runConversationTurn } from './turn.js'

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
/**
 * Null when no key is configured, and that is a supported state rather than a
 * degraded one. The worker still ingests, dispatches staff replies and honours
 * opt-outs; it simply produces no AI turn. Refusing to boot without a model
 * would take the whole inbox down for a missing API key.
 */
const model: ModelAdapter | null =
  env.OPENAI_API_KEY === undefined
    ? null
    : openaiModel({
        apiKey: env.OPENAI_API_KEY,
        model: env.AI_MODEL,
        effort: env.AI_REASONING_EFFORT,
      })

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

        // Jobs abandoned by a worker that died without shutting down.
        // graphile-worker would hold these for four hours, and per-conversation
        // serialisation means that is four hours of silence for one customer.
        /**
         * Handoffs nobody accepted in time.
         *
         * Section 18.11: when nobody accepts, a scheduled task checks the due
         * time, alerts the configured fallback owner, and keeps the queue item
         * visible. This runs on the same sweep as the abandoned-job check
         * because both answer the same question — what did we promise and then
         * fail to do.
         */
        for (const late of await escalateOverdueHandoffs(query)) {
          log({
            event: 'handoff.escalated',
            handoff: late.handoffId,
            conversation: late.conversationId,
            reason: late.reason,
            priority: late.priority,
            minutesLate: late.minutesLate,
            fallbackOwner: late.fallbackOwnerMembershipId,
            // Loud on purpose. An operator with no fallback owner should learn
            // it here rather than from a customer who waited all night.
            warning: late.fallbackOwnerMembershipId === null
              ? 'no fallback owner configured for this operator'
              : undefined,
          })
        }

        const abandoned = await releaseAbandonedJobs(query)
        if (abandoned.released > 0 || abandoned.queuesReleased > 0) {
          log({
            event: 'jobs.released',
            jobs: abandoned.released,
            queues: abandoned.queuesReleased,
            tasks: abandoned.tasks,
          })
        }
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

  /**
   * Named prepared statements off, because the database is behind a pooler.
   *
   * graphile-worker exposes this as `noPreparedStatements`. Its own guidance:
   * "Set false if you use software (e.g. some
   * Postgres pools) that don't support them." Supabase is exactly that
   * software. Its reset-locked maintenance query is issued as a prepared
   * statement named `clear_stale_locks/graphile_worker`, and on Render it
   * failed on a loop — "Failed to reset locked; we'll try again in 49922ms" —
   * on every instance, across restarts.
   *
   * Only the maintenance query failed, never job fetching, which fits a pooler
   * handing a recycled backend to an occasional query while long-lived worker
   * connections keep theirs. Our own statements were unaffected: postgres.js
   * is configured with prepare: false for this same reason.
   *
   * The cost is a little planning time per query. The thing it buys is the
   * routine that recovers jobs from a dead worker actually running.
   */
  noPreparedStatements: true,
  // Per-conversation ordering comes from the queue name on each job, not from
  // this number. Section 18.10 is explicit that a global concurrency setting
  // does not serialise a conversation.
  concurrency: 3,
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
   * Bigger than `concurrency`, and that ordering is the point.
   *
   * These were 5 and 4, which graphile-worker warns about on every boot:
   * "having maxPoolSize (4) smaller than concurrency (5) may lead to
   * non-optimal performance." The warning undersells it. Maintenance queries
   * draw from this same pool, so with every connection held by a running job
   * there is none left for reset-locked — the routine that recovers jobs from
   * a worker that died. On Render it failed repeatedly with backoff:
   * "Failed to reset locked; we'll try again in 39508ms".
   *
   * The failure is quiet in the worst way: jobs keep being processed, so the
   * worker looks healthy, while the mechanism that rescues stuck ones is the
   * part that cannot get a connection.
   *
   * Two spare connections above concurrency: one for maintenance, one for the
   * next thing that needs the pool. It still runs beside the postgres.js pool
   * this process opens, and both hold real backends on the session pooler, so
   * neither number should grow without checking Supabase's connection limit.
   */
  maxPoolSize: 5,
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

      /**
       * A voice note or photo: acknowledged honestly and put in front of a
       * person. Section 17 forbids treating it as though the customer said
       * nothing, which is what happened while this branch simply returned.
       */
      if (handling.reason === 'non_text_needs_a_person') {
        const routed = await handleNonTextMessage(
          { run: query, transact, destination: env.AI_AUTOSEND_ENABLED ? 'send' : 'draft' },
          context,
        )
        log({
          event: 'turn.completed',
          jobId: helpers.job.id,
          conversation: context.conversation.id,
          messageKind: context.message.kind,
          autosend: env.AI_AUTOSEND_ENABLED,
          ...routed,
        })
        return
      }

      if (handling.action !== 'draft') return

      /**
       * The AI turn. Everything above decided whether it should happen; this is
       * the first line in the system that actually asks a model anything.
       *
       * `destination` is the second switch, separate from the kill switch that
       * gated the decision above: in shadow mode the reply becomes an internal
       * note for a salesperson to read, and notes have no path to the
       * dispatcher at all.
       */
      const turn = await runConversationTurn(
        {
          run: query,
          transact,
          model,
          destination: env.AI_AUTOSEND_ENABLED ? 'send' : 'draft',
        },
        context,
      )
      log({
        event: 'turn.completed',
        jobId: helpers.job.id,
        conversation: context.conversation.id,
        model: model?.modelId ?? null,
        autosend: env.AI_AUTOSEND_ENABLED,
        ...turn,
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
  aiModel: model?.modelId ?? 'none configured',
  aiAutosend: env.AI_AUTOSEND_ENABLED,
  dispatcherAvailable: DISPATCHER_AVAILABLE,
  tasks: ['process_inbound_message', 'dispatch_outbound'],
})

await relayLoop()

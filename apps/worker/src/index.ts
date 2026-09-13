import { parseServerEnv } from '@vyra/contracts'
import { createClient } from '@vyra/db'
import { run as runWorker, type Runner } from 'graphile-worker'
import { dispatchMessage } from './dispatcher.js'
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

async function shutdown(signal: string): Promise<void> {
  log({ event: 'worker.shutdown', signal })
  running = false
  await relayInFlight.catch(() => {})
  await runner.stop().catch(() => {})
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
  dispatcherAvailable: DISPATCHER_AVAILABLE,
  tasks: ['process_inbound_message', 'dispatch_outbound'],
})

await relayLoop()

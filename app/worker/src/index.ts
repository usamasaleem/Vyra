import { parseServerEnv } from '@vyra/contracts'
import { openSecret } from '@vyra/contracts/secrets'
import { createClient } from '@vyra/db'
import { run as runWorker, type Runner } from 'graphile-worker'
import { dispatchMessage } from './dispatcher.js'
import { releaseAbandonedJobs } from './abandoned-jobs.js'
import { reapStaleDispatching } from './failures.js'
import {
  purgeExpiredConversations,
  escalateAbandonedConversations, escalateOverdueHandoffs, findSendingCredentials,
  resumeAbandonedConversations,
} from '@vyra/db'
import { sendDueFollowUps } from './follow-ups.js'
import { sendDueReminders } from './reminders.js'
import { publishToGraphileWorker, relayOnce, type QueryRunner, type Transactor } from './relay.js'
import { processInboundMessage } from './tasks/process-inbound-message.js'
import { createWhatsAppClient, type WhatsAppClient } from './whatsapp/client.js'
import { transcribeVoiceNote } from './transcribe-voice-note.js'
import {
  openaiModel, openaiTranscriber, PROMPT_VERSION,
  type ModelAdapter, type Transcriber,
} from '@vyra/agent'
import {
  acknowledgeWaiting, greetIfNew, fileDocumentIfBooked, handleNonTextMessage, handleUrgentMessage,
  noticeOutOfHours, runConversationTurn,
} from './turn.js'

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
        serviceTier: env.AI_SERVICE_TIER,
      })

/**
 * Voice notes, in words.
 *
 * Same key, separate adapter, because it is a different endpoint and a
 * different model — and null for the same reason the model above is: a missing
 * key should cost the transcription, not the worker.
 */
const transcriber: Transcriber | null =
  env.OPENAI_API_KEY === undefined ? null : openaiTranscriber({ apiKey: env.OPENAI_API_KEY })

/**
 * The worker's own credentials, still used for one number.
 *
 * The pilot's number predates per-operator tokens and has none stored, so it
 * falls back to these. Every number connected through the inbox carries its
 * own, and this fallback applies to exactly the one phone number id the
 * environment names — never to somebody else's, because sending as the wrong
 * business is the worst thing this system could do quietly.
 */
const whatsapp = createWhatsAppClient({
  apiVersion: env.WHATSAPP_API_VERSION,
  phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID,
  accessToken: env.WHATSAPP_ACCESS_TOKEN,
})

/**
 * One client per number, built once and kept.
 *
 * A client is a little configuration and a fetch; the reason to cache is not
 * cost but the sealed token — opening it on every send would put the plaintext
 * through the process far more often than it needs to be there.
 *
 * Cleared on a failed open rather than cached as null, so rotating a broken
 * token takes effect on the next message instead of on the next deploy.
 */
const clients = new Map<string, WhatsAppClient>()

const clientFor = async (phoneNumberId: string): Promise<WhatsAppClient | null> => {
  const cached = clients.get(phoneNumberId)
  if (cached !== undefined) return cached

  const credentials = await findSendingCredentials(query, phoneNumberId)
  if (credentials === null) {
    log({ event: 'whatsapp.unknown_number', phoneNumberId })
    return null
  }

  if (credentials.accessTokenCipher === null) {
    if (phoneNumberId !== env.WHATSAPP_PHONE_NUMBER_ID) {
      log({
        event: 'whatsapp.no_token',
        phoneNumberId,
        operator: credentials.operatorId,
        warning: 'this number has no stored token and is not the one this worker was configured with',
      })
      return null
    }
    clients.set(phoneNumberId, whatsapp)
    return whatsapp
  }

  const token = openSecret(credentials.accessTokenCipher, env.WHATSAPP_TOKEN_KEY)
  if (token === null) {
    log({
      event: 'whatsapp.token_unreadable',
      phoneNumberId,
      operator: credentials.operatorId,
      warning: 'the stored token could not be opened — check WHATSAPP_TOKEN_KEY',
    })
    return null
  }

  const client = createWhatsAppClient({
    apiVersion: env.WHATSAPP_API_VERSION,
    phoneNumberId,
    accessToken: token,
  })
  clients.set(phoneNumberId, client)
  return client
}

const DISPATCHER_AVAILABLE = true

/**
 * How long a job waited after it became due to run.
 *
 * `run_at` is when graphile-worker was allowed to start it, which for an
 * inbound turn is already two seconds after the message arrived — the
 * collection window. So this measures queue delay only, and a healthy number
 * here is a few hundred milliseconds.
 *
 * It exists because a customer's wait was being measured in two halves with a
 * hole between them. The outbox records publishing (sub-second), agent_runs
 * records the turn (a few seconds), and on 15 September a message sat between
 * the two for ninety-six seconds with nothing recording it. The only evidence
 * was the customer sending the message again.
 *
 * Clamped at zero: a job started slightly before its due time by clock skew
 * between the worker and the database has not waited a negative amount.
 */
function waitedMs(job: { run_at: Date }): number {
  return Math.max(0, Date.now() - job.run_at.getTime())
}

/**
 * A wait past this is worth seeing on its own, without anyone going looking.
 *
 * Not an error and not retried — the work did happen. It is logged loudly
 * because the alternative is what happened before: a delay nobody could see
 * afterwards, because completed jobs are deleted and leave no trace.
 */
const SLOW_QUEUE_MS = 15_000

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
            escalatedTo: late.escalatedToMembershipId,
            // Still worth saying — naming someone is the operator's call and a
            // longest-standing admin is a guess at it. But it is now a nudge
            // rather than the sound of an escalation hitting nobody.
            note: late.ownerWasImplied
              ? 'no fallback owner configured — escalated to the longest-standing admin'
              : undefined,
          })
        }

        /**
         * Conversations a person took and then stopped answering.
         *
         * The check above finds handoffs nobody accepted. This one finds the
         * opposite and worse case: somebody accepted, the customer asked one
         * more thing, and the AI is no longer allowed to answer it. The
         * conversation looks handled from the inside and silent from the
         * customer's side, and nothing was counting.
         *
         * Back to the queue it goes, owner intact — knowing who let it go is
         * part of what makes this worth recording.
         */
        for (const stalled of await escalateAbandonedConversations(query)) {
          log({
            event: 'conversation.customer_waiting',
            handoff: stalled.handoffId,
            conversation: stalled.conversationId,
            waitingMinutes: stalled.waitingMinutes,
            owner: stalled.ownerMembershipId,
            escalatedTo: stalled.escalatedToMembershipId,
          })
        }

        /**
         * Conversations a person took and then left.
         *
         * The escalation above tells somebody. This answers the customer,
         * which is the part that was missing: a conversation in human hands
         * schedules no follow-up, so until now nothing in this system was ever
         * going to speak to them again. Thirty-five hours was the worst
         * observed, and it ended because the operator noticed, not because
         * anything here did.
         *
         * Logged loudly. The agent replying where a person was expected to is
         * a fact the operator should be able to find without looking for it.
         */
        for (const back of await resumeAbandonedConversations(query)) {
          log({
            event: 'conversation.resumed_after_silence',
            conversation: back.conversationId,
            waitingMinutes: back.waitingMinutes,
            ownerMembershipId: back.ownerMembershipId,
            answering: back.waitingMessageId,
          })
        }

        // Chases that have come due. On the same sweep as the escalation check
        // because both are the system keeping a promise on a timer.
        const chased = await sendDueFollowUps(query, log)
        if (chased.sent > 0 || chased.raisedForAPerson > 0 || chased.rescheduled > 0) {
          log({ event: 'followups.swept', ...chased })
        }

        // The day before a car goes out, and the day before it comes back.
        const reminded = await sendDueReminders(query, log)
        if (reminded.sent > 0 || reminded.raisedForAPerson > 0) {
          log({ event: 'reminders.swept', ...reminded })
        }

        /**
         * And delete what the operator said to delete.
         *
         * retention_days has been on the settings page since the settings page
         * existed, saying "Conversations, contacts and anything a customer
         * sent", and nothing had ever removed a row. That is worse than a
         * missing button: a missing button is visible the moment somebody
         * looks for it, and this looked exactly like working software from
         * every angle available to the person relying on it.
         *
         * Batched, on the same sweep as everything else here, and it never
         * touches a conversation carrying a quote or a booking.
         */
        const purged = await purgeExpiredConversations(query)
        if (purged.conversations > 0) {
          log({ event: 'retention.purged', ...purged })
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

      const waited = waitedMs(helpers.job)
      if (waited > SLOW_QUEUE_MS) {
        log({ event: 'queue.slow', task: 'dispatch_outbound', jobId: helpers.job.id, waitedMs: waited })
      }

      const result = await dispatchMessage(query, clientFor, messageId)
      log({ event: 'dispatch.result', jobId: helpers.job.id, messageId, queueWaitMs: waited, ...result })

      /**
       * Anything queued to ride along with this message, in order.
       *
       * Photographs after a reply. One job rather than one each, because the
       * gap between them was queue latency rather than anything Meta does, and
       * four images arriving over five seconds feel slower than the same four
       * over half of one.
       *
       * Sent after the first succeeds, and sequentially: an album whose second
       * picture arrives before its first is worse than a slow album. A failure
       * here is logged and does not fail the job — the reply has already gone,
       * and retrying the job would try to send it twice.
       */
      const alongside = (payload as { also_message_ids?: unknown } | null)?.also_message_ids
      if (result.outcome === 'sent' && Array.isArray(alongside)) {
        for (const id of alongside) {
          if (typeof id !== 'string') continue
          try {
            const extra = await dispatchMessage(query, clientFor, id)
            log({ event: 'dispatch.result', jobId: helpers.job.id, messageId: id, ...extra })
          } catch (error) {
            log({
              event: 'dispatch.alongside_failed',
              jobId: helpers.job.id,
              messageId: id,
              error: error instanceof Error ? error.message : String(error),
            })
          }
        }
      }

      // Only a retryable failure should make graphile-worker try again. An
      // unknown outcome must not be retried at all: Meta may have delivered it.
      if (result.outcome === 'failed' && result.retryable) {
        throw new Error(`retryable send failure: ${result.error}`)
      }
    },

    process_inbound_message: async (payload, helpers) => {
      const queueWaitMs = waitedMs(helpers.job)
      if (queueWaitMs > SLOW_QUEUE_MS) {
        log({
          event: 'queue.slow',
          task: 'process_inbound_message',
          jobId: helpers.job.id,
          waitedMs: queueWaitMs,
        })
      }

      /**
       * A voice note becomes words before anything decides what to do with it.
       *
       * Before processInboundMessage rather than inside it, because that
       * function is a pure decision over a loaded context and this is two
       * network calls and a write. It runs first so `decideHandling` sees a
       * message with a body, and the ordinary turn answers it.
       *
       * Every failure lands in the same place: no transcriber, no media id, a
       * download that 401s, an unreadable format, an empty transcript. The body
       * stays null and the message routes to a person, which is what has always
       * happened to voice notes and works.
       */
      await transcribeVoiceNote({
        run: query, whatsapp, transcriber, log,
        messageId: (payload as { message_id?: unknown } | null)?.message_id,
      }).catch((error: unknown) => {
        log({
          event: 'transcribe.failed',
          jobId: helpers.job.id,
          error: error instanceof Error ? error.message : String(error),
        })
      })

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
        queueWaitMs,
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
       * Two blue ticks mean the business has read this, and the business has
       * to have read it.
       *
       * This was sent here for a few hours, before any branch, so that no path
       * left a customer on one grey tick. It made the wrong promise. A
       * conversation a salesperson owns is marked read by nobody — the inbox
       * sends no receipts at all — so the ticks said somebody was looking at a
       * message nobody had opened. Live: "what colour is this?" turned blue and
       * was never answered.
       *
       * A grey tick on an unread message is the truth. So the receipt goes with
       * the reply, wherever a reply is actually made, and nowhere else.
       */

      /**
       * A voice note or photo: acknowledged honestly and put in front of a
       * person. Section 17 forbids treating it as though the customer said
       * nothing, which is what happened while this branch simply returned.
       */
      /**
       * A rule stopped this before the model saw it: an accident, a fraud
       * dispute, a legal complaint.
       *
       * Before the non-text branch, and before the `action !== 'draft'` return
       * below, because holding without this is silence — and silence after "I
       * have had an accident" is the worst thing this system could produce.
       */
      if (handling.reason === 'urgent_needs_a_person' && handling.urgent !== undefined) {
        if (context.message.providerId !== null) {
          void whatsapp.markRead({ messageId: context.message.providerId })
        }
        const routed = await handleUrgentMessage(
          { run: query, transact, destination: env.AI_AUTOSEND_ENABLED ? 'send' : 'draft' },
          context,
          handling.urgent,
        )
        log({
          event: 'turn.completed',
          jobId: helpers.job.id,
          conversation: context.conversation.id,
          stoppedBy: handling.urgent.code,
          matched: handling.urgent.matched,
          ...routed,
        })
        return
      }

      if (handling.reason === 'non_text_needs_a_person') {
        if (context.message.providerId !== null) {
          void whatsapp.markRead({ messageId: context.message.providerId })
        }
        // A photo for a booking that is waiting on documents is filed, not
        // handed to a person. Anything else falls through to the handoff.
        const filed = await fileDocumentIfBooked(
          { run: query, transact, destination: env.AI_AUTOSEND_ENABLED ? 'send' : 'draft' },
          context,
        ).catch((error: unknown) => {
          log({ event: 'document.filing_failed', error: error instanceof Error ? error.message : String(error) })
          return null
        })
        if (filed !== null) {
          log({ event: 'turn.completed', jobId: helpers.job.id, conversation: context.conversation.id,
            messageKind: context.message.kind, autosend: env.AI_AUTOSEND_ENABLED, ...filed })
          return
        }
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

      /**
       * Held because a person owns it — and nobody has picked it up.
       *
       * The handoff itself works: the queue has it, the SLA is running, the
       * escalation names somebody. The customer was the part nothing covered.
       * Told "I've connected you with an agent", they asked which colours were
       * available and got nothing, then "??", then "Hi?", then to change their
       * dates — five messages into five minutes of silence while
       * ai_resumes_after_minutes counted down.
       *
       * One line, once per handoff, and only while the handoff is genuinely
       * unclaimed. A salesperson who has accepted it is present, and talking
       * over them is worse than the quiet.
       */
      if (handling.reason === 'human_owns_the_conversation') {
        const told = await acknowledgeWaiting(
          { run: query, transact, destination: env.AI_AUTOSEND_ENABLED ? 'send' : 'draft' },
          context,
        )
        if (told.outcome === 'queued') {
          /**
           * Only when the line actually goes out — which is once per handoff.
           *
           * Every message after that is a customer waiting on a person who has
           * not opened the conversation, and a blue tick there says somebody
           * has. They have not, and the grey tick is the honest signal that
           * this is still sitting unread.
           */
          if (context.message.providerId !== null) {
            void whatsapp.markRead({ messageId: context.message.providerId })
          }
          log({
            event: 'waiting.acknowledged',
            jobId: helpers.job.id,
            conversation: context.conversation.id,
          })
        }
        return
      }

      if (handling.action !== 'draft') return

      /**
       * The operator's own two messages, before the agent says anything.
       *
       * Awaited, and in this order, because both are addressed to somebody who
       * has not been spoken to yet: a greeting that lands after the answer it
       * was meant to introduce is not a greeting.
       *
       * Neither sends unless the operator has written it. Both are idempotent
       * — once per contact, once per closed night — so a retried job repeats
       * nothing.
       */
      const written = { run: query, transact, destination: env.AI_AUTOSEND_ENABLED ? 'send' as const : 'draft' as const }
      const greeted = await greetIfNew(written, context).catch(() => false)
      const noticed = await noticeOutOfHours(written, context).catch(() => false)
      if (greeted || noticed) {
        log({
          event: 'written.sent',
          jobId: helpers.job.id,
          conversation: context.conversation.id,
          greeting: greeted,
          outOfHours: noticed,
        })
      }

      /**
       * Two blue ticks and a typing indicator, before the model is asked
       * anything.
       *
       * A reply takes about nine seconds, most of it the model thinking. This
       * makes none of that shorter; it turns nine seconds of silence into nine
       * seconds of somebody visibly writing, which is most of what a customer
       * means by fast.
       *
       * Here rather than on receipt, because Meta asks that an indicator only
       * be shown when a reply is actually coming — and this is the line after
       * which one is. Not awaited for correctness: it is a courtesy, and a
       * courtesy must not delay the thing it is apologising for.
       */
      if (context.message.providerId !== null) {
        void whatsapp.showTyping({ messageId: context.message.providerId })
      }

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
          queueWaitMs,
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

/**
 * Which build is actually running.
 *
 * Read straight from process.env rather than the env schema because it is a
 * diagnostic, not configuration: the service runs identically without it, and
 * requiring it would make the worker refuse to boot anywhere but Render.
 *
 * This exists because of a question that could not be answered. A fix was
 * pushed, the agent kept giving the old reply, and there was no way to tell
 * whether the deploy had landed or the change had not worked — nothing records
 * which code produced a live reply. Two candidate explanations and no evidence
 * between them is the position this line is meant to prevent.
 */
const commit = process.env['RENDER_GIT_COMMIT'] ?? 'unknown'

log({
  event: 'worker.start',
  node: process.version,
  nodeEnv: env.NODE_ENV,
  commit: commit === 'unknown' ? 'unknown' : commit.slice(0, 7),
  promptVersion: PROMPT_VERSION,
  aiSendingEnabled: env.AI_SENDING_ENABLED,
  aiModel: model?.modelId ?? 'none configured',
  aiAutosend: env.AI_AUTOSEND_ENABLED,
  dispatcherAvailable: DISPATCHER_AVAILABLE,
  tasks: ['process_inbound_message', 'dispatch_outbound'],
})

await relayLoop()

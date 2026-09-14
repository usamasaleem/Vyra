import { queueOutboundText, type QueuedOutbound } from './outbound.js'
import type { Transactor } from '../runner.js'

/**
 * Build plan step 25 — the check that runs before model output is accepted.
 *
 * Section 18.10: "Long model calls run outside database transactions; a short
 * transaction checks the revision before accepting their output."
 *
 * The window this closes is small and entirely ordinary. A model call takes a
 * few seconds. In those seconds a customer can send "sorry, Saturday not
 * Friday", or a salesperson can hit Take over. The reply that arrives
 * afterwards was written for a conversation that no longer exists.
 *
 * The dispatcher already compares `revision_at_send` against the conversation
 * revision, and that check is not this one. It catches drift between queueing
 * and sending. This catches drift between the model *starting* and the output
 * being queued — and without it the dispatcher check cannot help, because
 * `queueOutboundText` stamps whatever revision is current at queue time. A
 * stale reply would be stamped with the new revision, match perfectly, and
 * send.
 *
 * Rejection is the normal outcome here, not an error. The turn is simply
 * discarded: the customer's newer message already has a job of its own, and
 * that turn will produce a reply for what they actually said.
 */

export type TurnRejection =
  /** The conversation moved on: a correction, a takeover, a handoff, an opt-out. */
  | 'superseded'
  /** A person owns the reply now. */
  | 'human_took_over'
  /** They asked not to be messaged. */
  | 'contact_opted_out'
  | 'conversation_gone'

export type TurnAcceptance =
  | { accepted: true; queued: QueuedOutbound; revision: number }
  | { accepted: false; reason: TurnRejection; revisionNow: number | null }

export async function acceptTurnOutput(
  transact: Transactor,
  input: {
    conversationId: string
    operatorId: string
    /**
     * The conversation revision read before the model was called.
     *
     * The whole mechanism rests on this being captured *before* the model
     * runs, not after. Read afterwards it always matches, and the check
     * silently becomes a no-op that looks like it is working.
     */
    revisionAtTurnStart: number
    body: string
    /** Stable per logical reply, e.g. `turn:<message_id>`. */
    idempotencyKey: string
  },
): Promise<TurnAcceptance> {
  return transact(async (tx) => {
    /**
     * `for update` on the conversation row, so two turns for the same
     * conversation cannot both pass the check and both queue a reply. The
     * queue already serialises per conversation; this makes the guarantee hold
     * even if that changes.
     */
    const rows = await tx(
      `select v.revision, v.handler_mode::text as handler_mode, c.opted_out_at
       from conversations v
       join contacts c on c.id = v.contact_id and c.operator_id = v.operator_id
       where v.id = $1 and v.operator_id = $2
       for update of v`,
      [input.conversationId, input.operatorId],
    )

    const row = rows[0]
    if (row === undefined) {
      return { accepted: false, reason: 'conversation_gone', revisionNow: null } as const
    }

    const revisionNow = Number(row['revision'])

    // Checked before the revision, because it is the more useful thing to read
    // in an audit trail: "a person took over" explains more than "the number
    // changed", even though the takeover is what changed it.
    if (row['handler_mode'] === 'human') {
      return { accepted: false, reason: 'human_took_over', revisionNow } as const
    }
    if (row['opted_out_at'] !== null) {
      return { accepted: false, reason: 'contact_opted_out', revisionNow } as const
    }
    if (revisionNow !== input.revisionAtTurnStart) {
      return { accepted: false, reason: 'superseded', revisionNow } as const
    }

    // Through the one and only path that creates an outbound message. Section
    // 18.12: never build a second way to send.
    const queued = await queueOutboundText(tx, {
      conversationId: input.conversationId,
      operatorId: input.operatorId,
      body: input.body,
      idempotencyKey: input.idempotencyKey,
    })

    return { accepted: true, queued, revision: revisionNow } as const
  })
}

/**
 * Records a turn that was thrown away.
 *
 * A discarded turn is invisible by nature — no message appears, and nothing
 * failed. Section 14 asks for reliability to be visible, and "the AI wrote a
 * reply and we binned it" is exactly the kind of thing that should be
 * answerable later, especially when a customer says they never got an answer.
 */
export async function recordRejectedTurn(
  transact: Transactor,
  input: {
    conversationId: string
    operatorId: string
    reason: TurnRejection
    revisionAtTurnStart: number
    revisionNow: number | null
  },
): Promise<void> {
  await transact(async (tx) => {
    await tx(
      `insert into audit_events (
         operator_id, actor_type, action, subject_type, subject_id, subject_version, data
       ) values ($1, 'ai', 'turn.rejected', 'conversation', $2, $3,
                 jsonb_build_object('reason', $4::text, 'revision_at_turn_start', $5::int))`,
      [
        input.operatorId,
        input.conversationId,
        input.revisionNow,
        input.reason,
        input.revisionAtTurnStart,
      ],
    )
  })
}

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

/**
 * Where an accepted reply goes.
 *
 * `send` queues it for the dispatcher. `draft` writes it as an internal note
 * instead — shadow mode, where the AI writes every reply and a person decides
 * whether to send it (build plan step 33).
 *
 * A note is the right vehicle rather than a convenient one. Section 18.12:
 * "Never expose internal notes to the outbound dispatcher." So a shadow draft
 * is not merely unsent, it has no path to a customer at all — no flag to
 * misread, no delivery state to mistake for pending. The safety comes from the
 * structure rather than from remembering.
 */
export type TurnDestination = 'send' | 'draft'

export type TurnAcceptance =
  | { accepted: true; destination: 'send'; queued: QueuedOutbound; revision: number }
  | { accepted: true; destination: 'draft'; noteId: string | null; revision: number }
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
    /** Defaults to sending. Shadow mode passes 'draft'. */
    destination?: TurnDestination
    /**
     * Set when this turn called `request_handoff` itself.
     *
     * Without it the check rejects the acknowledgement of the handoff that
     * triggered it: the model hands over, the conversation becomes
     * human-owned, and the reply explaining that to the customer is discarded
     * as superseded. Live test, first try — a customer asked to speak to
     * someone and got silence, which is the one response section 17.6 rules
     * out.
     *
     * The allowance is exactly one revision wide, because the handoff bumps it
     * by exactly one. If the customer also sent a message in that window the
     * total is two, and the turn is rejected as it should be: their newer
     * message is what deserves an answer.
     */
    ownHandoff?: boolean
    /** Reply buttons to offer with this message, or null for plain text. */
    replyButtons?: Array<{ id: string; title: string }> | null
    /** A tappable list of options. A message carries buttons or a list, not both. */
    replyList?: { button: string; rows: Array<{ id: string; title: string; description?: string }> } | null
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
    //
    // A turn that handed off itself is the exception: it made this conversation
    // human-owned a moment ago, and what it wants to send is the sentence
    // telling the customer so.
    if (row['handler_mode'] === 'human' && input.ownHandoff !== true) {
      return { accepted: false, reason: 'human_took_over', revisionNow } as const
    }
    if (row['opted_out_at'] !== null) {
      return { accepted: false, reason: 'contact_opted_out', revisionNow } as const
    }
    // One revision of slack for the turn's own handoff, and no more.
    const expected = input.ownHandoff === true
      ? [input.revisionAtTurnStart, input.revisionAtTurnStart + 1]
      : [input.revisionAtTurnStart]
    if (!expected.includes(revisionNow)) {
      return { accepted: false, reason: 'superseded', revisionNow } as const
    }

    if (input.destination === 'draft') {
      // The author is null: nobody wrote this, and a note attributed to a
      // salesperson who did not write it would be worse than no attribution.
      const noted = await tx(
        `insert into conversation_notes (operator_id, conversation_id, author_membership_id, body)
         values ($1, $2, null, $3) returning id`,
        [input.operatorId, input.conversationId, `AI draft — not sent:\n\n${input.body}`],
      )
      return {
        accepted: true,
        destination: 'draft',
        noteId: (noted[0]?.['id'] as string) ?? null,
        revision: revisionNow,
      } as const
    }

    // Through the one and only path that creates an outbound message. Section
    // 18.12: never build a second way to send.
    const queued = await queueOutboundText(tx, {
      replyButtons: input.replyButtons ?? null,
      replyList: input.replyList ?? null,
      conversationId: input.conversationId,
      operatorId: input.operatorId,
      body: input.body,
      idempotencyKey: input.idempotencyKey,
    })

    return { accepted: true, destination: 'send', queued, revision: revisionNow } as const
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

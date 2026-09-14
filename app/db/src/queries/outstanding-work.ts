import type { QueryRunner } from '../runner.js'

/**
 * Recording what the agent promised a person would do.
 *
 * The gap this closes: the agent told a customer "I'm confirming whether it's
 * available, and I'll also confirm the deposit", and nothing existed anywhere
 * to confirm either. No task, no handoff, no flag — a salesperson looking at
 * that conversation saw an ordinary thread with nothing marked as needing them.
 *
 * The conversation stays with the AI on purpose. Handing off every question the
 * operator has not yet answered would stop the agent dead in nearly every
 * conversation, since none of the six policy questions are answered yet — and
 * an agent that cannot qualify a lead because it cannot quote a deposit is
 * worse than no agent. A real sales desk carries on asking about dates while
 * someone else looks up the deposit. So this raises visible work and leaves the
 * conversation running.
 *
 * That is the distinction from `recordTurnFailure`, which does take the
 * conversation away: a failed turn means the agent cannot continue, where
 * outstanding work only means it cannot finish.
 */

export type OutstandingWorkResult = {
  /** False when a person already owns the conversation, or nothing changed. */
  recorded: boolean
  nextAction: string | null
}

const RECORD_SQL = `
with updated as (
  update conversations
  set next_action = $3, updated_at = now()
  where id = $1
    and operator_id = $2
    -- A person who owns this conversation has their own next action, and a
    -- machine must not overwrite it.
    and handler_mode = 'ai'
    -- Idempotent: a retried job recording the same needs changes nothing, and
    -- leaves no second audit event.
    and next_action is distinct from $3
  returning id, operator_id
),
audited as (
  insert into audit_events (
    operator_id, actor_type, action, subject_type, subject_id, data
  )
  select u.operator_id, 'ai', 'conversation.needs_operator_input', 'conversation', u.id,
         jsonb_build_object('items', $4::jsonb, 'message_id', $5::uuid)
  from updated u
  returning id
)
select (select id from updated) as conversation_id
`

export async function recordOutstandingWork(
  run: QueryRunner,
  input: {
    conversationId: string
    operatorId: string
    /** Short phrases from the tools, e.g. 'check availability of Ferrari 488 for 2026-09-17'. */
    items: readonly string[]
    messageId: string
  },
): Promise<OutstandingWorkResult> {
  const items = [...new Set(input.items)].filter((i) => i.trim() !== '')
  if (items.length === 0) return { recorded: false, nextAction: null }

  // One line, because it is read in a list of conversations rather than opened.
  const nextAction = `Waiting on you: ${items.join('; ')}`

  const rows = await run(RECORD_SQL, [
    input.conversationId,
    input.operatorId,
    nextAction,
    JSON.stringify(items),
    input.messageId,
  ])

  return { recorded: rows[0]?.['conversation_id'] != null, nextAction }
}

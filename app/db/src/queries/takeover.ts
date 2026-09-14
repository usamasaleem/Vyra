import type { QueryRunner } from '../runner.js'

/**
 * Build plan step 17 — human takeover.
 *
 * Section 18.11 describes this as one backend transaction: verify the role,
 * change handler mode, assign the owner, increment the revision, and invalidate
 * pending AI send intents. It is one statement here so that it cannot half
 * happen. A conversation marked human-owned while an AI draft is still
 * dispatchable is the competing-reply failure the whole mechanism exists to
 * prevent.
 *
 * The boundary is worth stating precisely: an AI message already handed to
 * Meta cannot be recalled. This cancels what has not yet reached the
 * dispatcher, and the dispatcher re-checks ownership again immediately before
 * sending, so a draft in flight between the two is caught there.
 */
const TAKE_OVER_SQL = `
with taken as (
  update conversations
  set handler_mode = 'human',
      owner_membership_id = $3,
      revision = revision + 1,
      updated_at = now()
  where id = $1 and operator_id = $2
  returning id, operator_id, revision
),
cancelled as (
  update messages m
  set delivery_state = 'cancelled', error_code = 'conversation_taken_over'
  from taken t
  where m.conversation_id = t.id
    and m.operator_id = t.operator_id
    and m.direction = 'outbound'
    and m.delivery_state = 'pending'
    -- Only AI drafts. A salesperson's own queued message still stands.
    and m.sent_by_membership_id is null
  returning m.id
),
chased as (
  -- Section 11: stop automation after human takeover. A salesperson who has
  -- taken a conversation does not want the agent chasing beside them.
  update follow_ups f
  set state = 'cancelled', cancelled_reason = 'taken_over', cancelled_at = now(),
      updated_at = now()
  from taken t
  where f.conversation_id = t.id and f.operator_id = t.operator_id and f.state = 'scheduled'
  returning f.id
),
audited as (
  insert into audit_events (
    operator_id, actor_type, actor_id, action, subject_type, subject_id, subject_version, data
  )
  select t.operator_id, 'user', $3, 'conversation.takeover', 'conversation', t.id, t.revision,
         jsonb_build_object(
           'cancelled_drafts', (select count(*) from cancelled),
           'cancelled_follow_ups', (select count(*) from chased)
         )
  from taken t
  returning id
)
select (select revision from taken)              as revision,
       (select count(*)::int from cancelled)     as cancelled_drafts,
       (select id from taken)                    as conversation_id
`

export type TakeoverResult = {
  taken: boolean
  revision: number | null
  cancelledDrafts: number
}

export async function takeOverConversation(
  run: QueryRunner,
  input: { conversationId: string; operatorId: string; membershipId: string },
): Promise<TakeoverResult> {
  const rows = await run(TAKE_OVER_SQL, [
    input.conversationId,
    input.operatorId,
    input.membershipId,
  ])
  const row = rows[0]
  const taken = row?.['conversation_id'] != null
  return {
    taken,
    revision: taken ? Number(row?.['revision']) : null,
    cancelledDrafts: Number(row?.['cancelled_drafts'] ?? 0),
  }
}

/**
 * Returning control to the AI is an explicit staff action, never automatic.
 *
 * The revision increments here too: work drafted against the human-owned state
 * should not be accepted after control changes hands back.
 */
const RESUME_SQL = `
with resumed as (
  update conversations
  set handler_mode = 'ai',
      owner_membership_id = null,
      revision = revision + 1,
      updated_at = now()
  where id = $1 and operator_id = $2 and handler_mode = 'human'
  returning id, operator_id, revision
),
audited as (
  insert into audit_events (
    operator_id, actor_type, actor_id, action, subject_type, subject_id, subject_version
  )
  select r.operator_id, 'user', $3, 'conversation.resume_ai', 'conversation', r.id, r.revision
  from resumed r
  returning id
)
select (select revision from resumed) as revision, (select id from resumed) as conversation_id
`

export async function resumeAi(
  run: QueryRunner,
  input: { conversationId: string; operatorId: string; membershipId: string },
): Promise<{ resumed: boolean; revision: number | null }> {
  const rows = await run(RESUME_SQL, [
    input.conversationId,
    input.operatorId,
    input.membershipId,
  ])
  const row = rows[0]
  const resumed = row?.['conversation_id'] != null
  return { resumed, revision: resumed ? Number(row?.['revision']) : null }
}

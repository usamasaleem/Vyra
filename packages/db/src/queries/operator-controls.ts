import type { QueryRunner } from '../runner.js'

/**
 * Build plan step 19 — the AI kill switch.
 *
 * Section 14 requires a switch that stops AI replies instantly while ingestion
 * and staff access keep working. That shape matters: the temptation when
 * something goes wrong is to turn the webhook off, which stops the AI and also
 * stops capturing customers. This stops only the AI.
 *
 * There are two switches. This is the per-operator one, flipped from the inbox.
 * The environment-level one stops every operator at once and is deliberately
 * not reachable from a browser — it is for the moment when the inbox itself is
 * not to be trusted.
 */
const SET_AI_SQL = `
with updated as (
  update operators set ai_sending_enabled = $2, updated_at = now()
  where id = $1
  returning id, ai_sending_enabled, policy_version
),
audited as (
  insert into audit_events (
    operator_id, actor_type, actor_id, action, subject_type, subject_id, data
  )
  select u.id, 'user', $3,
         case when u.ai_sending_enabled then 'operator.ai_enabled' else 'operator.ai_disabled' end,
         'operator', u.id,
         jsonb_build_object('ai_sending_enabled', u.ai_sending_enabled)
  from updated u
  returning id
)
select (select ai_sending_enabled from updated) as ai_sending_enabled,
       (select id from updated) as operator_id
`

export async function setOperatorAiSending(
  run: QueryRunner,
  input: { operatorId: string; enabled: boolean; membershipId: string },
): Promise<{ changed: boolean; aiSendingEnabled: boolean | null }> {
  const rows = await run(SET_AI_SQL, [input.operatorId, input.enabled, input.membershipId])
  const row = rows[0]
  const changed = row?.['operator_id'] != null
  return {
    changed,
    aiSendingEnabled: changed ? row?.['ai_sending_enabled'] === true : null,
  }
}

/** Everything the inbox header needs about the operator's current posture. */
export async function getOperatorStatus(
  run: QueryRunner,
  operatorId: string,
): Promise<{ name: string; timezone: string; aiSendingEnabled: boolean } | null> {
  const rows = await run(
    `select name, timezone, ai_sending_enabled from operators where id = $1`,
    [operatorId],
  )
  const row = rows[0]
  if (row === undefined) return null
  return {
    name: row['name'] as string,
    timezone: row['timezone'] as string,
    aiSendingEnabled: row['ai_sending_enabled'] === true,
  }
}

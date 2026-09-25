import { renderTemplate, TEMPLATES, templateParam, type TemplateKey } from '@vyra/contracts'
import type { QueryRunner } from '../runner.js'

/**
 * Templates: what Meta has approved, and sending one.
 *
 * A template is only ever sent while Meta's last word on it here is APPROVED.
 * Anything else — pending, rejected, paused, never submitted — and the caller
 * falls back to what it always did: a task for a person. So submitting them
 * cannot make anything worse, and approval makes things better on its own.
 */

export type TemplateStatus = {
  key: TemplateKey
  name: string
  category: string
  body: string
  purpose: string
  status: string
  rejectedReason: string | null
  checkedAt: Date | null
}

export async function recordTemplateStatus(
  run: QueryRunner,
  input: {
    operatorId: string
    name: string
    language: string
    category: string
    body: string
    status: string
    providerTemplateId?: string | null
    rejectedReason?: string | null
    submitted?: boolean
  },
): Promise<void> {
  await run(
    `insert into whatsapp_templates (operator_id, name, language, category, body, status, provider_template_id,
                                     rejected_reason, submitted_at, checked_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, case when $9 then now() end, now())
     on conflict (operator_id, name, language) do update
       set status = excluded.status, category = excluded.category, body = excluded.body,
           provider_template_id = coalesce(excluded.provider_template_id, whatsapp_templates.provider_template_id),
           rejected_reason = excluded.rejected_reason,
           submitted_at = coalesce(excluded.submitted_at, whatsapp_templates.submitted_at),
           checked_at = now()`,
    [input.operatorId, input.name, input.language, input.category, input.body, input.status,
      input.providerTemplateId ?? null, input.rejectedReason ?? null, input.submitted === true],
  )
}

export async function templateApproved(
  run: QueryRunner,
  input: { operatorId: string; key: TemplateKey },
): Promise<boolean> {
  const t = TEMPLATES[input.key]
  const [row] = await run(
    `select 1 from whatsapp_templates where operator_id = $1 and name = $2 and language = $3 and status = 'APPROVED'`,
    [input.operatorId, t.name, t.language],
  )
  return row !== undefined
}

export async function listTemplateStatus(run: QueryRunner, operatorId: string): Promise<TemplateStatus[]> {
  const rows = await run(
    `select name, status, rejected_reason, checked_at from whatsapp_templates where operator_id = $1`,
    [operatorId],
  )
  const byName = new Map(rows.map((r) => [r['name'] as string, r]))
  return (Object.keys(TEMPLATES) as TemplateKey[]).map((key) => {
    const t = TEMPLATES[key]
    const row = byName.get(t.name)
    return {
      key, name: t.name, category: t.category, body: t.body, purpose: t.purpose,
      status: (row?.['status'] as string) ?? 'NOT_SUBMITTED',
      rejectedReason: (row?.['rejected_reason'] as string) ?? null,
      checkedAt: row?.['checked_at'] == null ? null : new Date(row['checked_at'] as string),
    }
  })
}

/**
 * A template, queued like any other outbound message: one row, one dispatch
 * job, idempotent on its key. The body is the rendered sentence, so the inbox
 * shows exactly what the customer read.
 */
export async function queueTemplateMessage(
  run: QueryRunner,
  input: { operatorId: string; conversationId: string; key: TemplateKey; params: string[]; idempotencyKey: string },
): Promise<{ messageId: string | null }> {
  const t = TEMPLATES[input.key]
  const params = input.params.map(templateParam)
  const rows = await run(
    `with conversation as (
       select id, operator_id, revision from conversations where id = $1 and operator_id = $2
     ),
     intent as (
       insert into messages (operator_id, conversation_id, direction, kind, body, delivery_state, idempotency_key,
                             revision_at_send, template)
       select v.operator_id, v.id, 'outbound', 'template', $3, 'pending', $4, v.revision, $5::jsonb
       from conversation v
       on conflict do nothing
       returning id, operator_id, conversation_id
     ),
     job as (
       insert into outbox (operator_id, event_type, aggregate_id, payload)
       select i.operator_id, 'dispatch_outbound', i.id,
              jsonb_build_object('message_id', i.id, 'conversation_id', i.conversation_id, 'also_message_ids', '[]'::jsonb)
       from intent i
       returning id
     )
     select (select id from intent) as message_id`,
    [input.conversationId, input.operatorId, renderTemplate(input.key, params), input.idempotencyKey,
      JSON.stringify({ name: t.name, language: t.language, params })],
  )
  return { messageId: (rows[0]?.['message_id'] as string) ?? null }
}

/**
 * The customer answered the reopening template: a colleague's message that
 * was held for them goes out now, in the order it was written.
 */
export async function releaseHeldMessages(
  run: QueryRunner,
  input: { operatorId: string; conversationId: string },
): Promise<{ released: number }> {
  const rows = await run(
    `with held as (
       update messages set delivery_state = 'pending', error_code = null, error_detail = null
       where operator_id = $1 and conversation_id = $2 and direction = 'outbound'
         and delivery_state = 'cancelled' and error_code = 'awaiting_customer_reply'
         and created_at > now() - interval '7 days'
       returning id, operator_id, conversation_id, created_at
     )
     insert into outbox (operator_id, event_type, aggregate_id, payload)
     select h.operator_id, 'dispatch_outbound', h.id,
            jsonb_build_object('message_id', h.id, 'conversation_id', h.conversation_id, 'also_message_ids', '[]'::jsonb)
     from held h order by h.created_at
     returning id`,
    [input.operatorId, input.conversationId],
  )
  return { released: rows.length }
}

import { currentActor } from '@/lib/auth'
import { actorRunner } from '@/lib/db'

/**
 * A cheap "has anything moved?" check for the inbox to poll.
 *
 * Section 18.12 recommends polling before realtime for the pilot, and this is
 * the shape that makes polling affordable: it returns a fingerprint, not data.
 * The client refreshes the page only when the fingerprint changes, so a quiet
 * inbox costs one small query every few seconds rather than a full render
 * against a database several hundred milliseconds away.
 *
 * The thread fingerprint deliberately covers three things that each mean
 * something different to a salesperson:
 *
 *   - a new message arrived
 *   - a message changed delivery state (queued, sent, delivered, read, failed)
 *   - the conversation revision moved, which is how someone else taking over
 *     becomes visible. Without that, two people can be typing replies into a
 *     conversation only one of them owns.
 */

const THREAD_SQL = `
  select
    v.revision,
    v.handler_mode::text as handler_mode,
    v.sales_stage::text  as sales_stage,
    v.owner_membership_id,
    (
      select md5(coalesce(string_agg(m.id::text || ':' || m.delivery_state::text, ',' order by m.created_at), ''))
      from messages m
      where m.conversation_id = v.id and m.operator_id = v.operator_id
    ) as message_digest
  from conversations v
  where v.id = $1 and v.operator_id = $2
`

const LIST_SQL = `
  select md5(coalesce(string_agg(
           v.id::text || ':' || v.sales_stage::text || ':' || v.handler_mode::text || ':' ||
           coalesce(v.last_customer_message_at::text, '') || ':' || v.updated_at::text,
           ',' order by v.id), '')) as digest
  from conversations v
  where v.operator_id = $1
`

export async function GET(request: Request): Promise<Response> {
  const actor = await currentActor()
  if (actor === null) {
    return Response.json({ error: 'not signed in' }, { status: 401 })
  }

  const conversationId = new URL(request.url).searchParams.get('conversation')
  const run = actorRunner(actor)

  if (conversationId === null) {
    const rows = await run(LIST_SQL, [actor.operatorId])
    return Response.json(
      { fingerprint: String(rows[0]?.['digest'] ?? '') },
      { headers: { 'cache-control': 'no-store' } },
    )
  }

  // Operator-scoped: another operator's conversation simply has no fingerprint.
  const rows = await run(THREAD_SQL, [conversationId, actor.operatorId])
  const row = rows[0]
  if (row === undefined) {
    return Response.json({ error: 'not found' }, { status: 404 })
  }

  const fingerprint = [
    row['revision'],
    row['handler_mode'],
    row['sales_stage'],
    row['owner_membership_id'] ?? '',
    row['message_digest'],
  ].join('|')

  return Response.json({ fingerprint }, { headers: { 'cache-control': 'no-store' } })
}

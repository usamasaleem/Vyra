import type { QueryRunner } from '../runner.js'

/**
 * Build plan step 32 — the ten measures section 15 asks for, and only those.
 *
 * The list is deliberately short and the spec is explicit about what is not on
 * it: "Fleet, availability, vehicle utilisation, delivery, maintenance,
 * payment, deposit, document, and operational reports belong to the Operations
 * Agent." A sales dashboard that drifts into fleet utilisation is answering
 * somebody else's question.
 *
 * Every number here comes from a record written at the moment the thing
 * happened. Four of the ten had no input at all until now — first-response
 * time, time to salesperson, lost reasons and incorrect answers — because the
 * columns existed and nothing wrote them.
 *
 * Medians, not averages. One conversation that sat over a weekend drags a mean
 * far enough to hide a week of fast replies, and the question being asked is
 * "how long does a customer usually wait".
 */

export type Metrics = {
  from: Date
  to: Date
  /** Conversations that received at least one customer message in the window. */
  enquiries: number
  /** Median seconds from the first customer message to the first reply sent. */
  firstResponseSeconds: number | null
  /** Enquiries with everything section 3 requires, over all enquiries. */
  qualificationRate: number | null
  qualifiedLeads: number
  handoffs: number
  /** Median seconds from a handoff being raised to somebody accepting it. */
  timeToSalespersonSeconds: number | null
  quoteRequests: number
  quotesSent: number
  won: number
  lost: number
  lostReasons: Array<{ reason: string; count: number }>
  /** Flagged by a person as untrue. Nothing else can detect one. */
  incorrectAnswers: number
  complaints: number
}

const METRICS_SQL = `
with window_bounds as (
  /**
   * The upper bound is the database's own clock, not a timestamp from the
   * caller.
   *
   * A JavaScript Date has millisecond precision and PostgreSQL stores
   * microseconds, so a row written at .941500 was excluded by a ceiling of
   * .941 — anything created in the same millisecond as the report simply did
   * not appear. It surfaced as a test that failed only when it ran fast enough,
   * and passed the moment a console.log slowed it down.
   *
   * Using now() also removes clock skew between the application host and the
   * database, which is the same bug with a bigger window.
   */
  select $2::timestamptz as from_at, coalesce($3::timestamptz, now()) as to_at
),
enquiry_conversations as (
  select distinct m.conversation_id
  from messages m, window_bounds w
  where m.operator_id = $1 and m.direction = 'inbound'
    and m.created_at >= w.from_at and m.created_at < w.to_at
),
first_response as (
  select v.id,
         extract(epoch from v.first_response_at - first_in.at)::int as seconds
  from conversations v
  join enquiry_conversations e on e.conversation_id = v.id
  join lateral (
    select min(created_at) as at from messages
    where conversation_id = v.id and operator_id = v.operator_id and direction = 'inbound'
  ) first_in on true
  where v.first_response_at is not null and v.first_response_at > first_in.at
),
qualification as (
  select
    count(*)::int as total,
    count(*) filter (
      where (select count(distinct field) from field_evidence fe
             where fe.enquiry_id = e.id and fe.superseded_at is null
               and fe.field in ('vehicle', 'start_at', 'delivery_preference')) = 3
    )::int as complete
  from enquiries e, window_bounds w
  where e.operator_id = $1 and e.created_at >= w.from_at and e.created_at < w.to_at
),
handoff_times as (
  select extract(epoch from h.accepted_at - h.created_at)::int as seconds
  from handoffs h, window_bounds w
  where h.operator_id = $1 and h.created_at >= w.from_at and h.created_at < w.to_at
    and h.accepted_at is not null
)
select
  (select count(*)::int from enquiry_conversations) as enquiries,
  (select percentile_cont(0.5) within group (order by seconds) from first_response)
    as first_response_seconds,
  (select case when total = 0 then null else complete::float / total end from qualification)
    as qualification_rate,
  (select complete from qualification) as qualified_leads,
  (select count(*)::int from handoffs h, window_bounds w
   where h.operator_id = $1 and h.created_at >= w.from_at and h.created_at < w.to_at) as handoffs,
  (select percentile_cont(0.5) within group (order by seconds) from handoff_times)
    as time_to_salesperson_seconds,
  (select count(*)::int from quotes q, window_bounds w
   where q.operator_id = $1 and q.created_at >= w.from_at and q.created_at < w.to_at)
    as quote_requests,
  (select count(*)::int from quotes q, window_bounds w
   where q.operator_id = $1 and q.state = 'sent'
     and q.updated_at >= w.from_at and q.updated_at < w.to_at) as quotes_sent,
  (select count(*)::int from audit_events a, window_bounds w
   where a.operator_id = $1 and a.action = 'lead.won'
     and a.created_at >= w.from_at and a.created_at < w.to_at) as won,
  (select count(*)::int from audit_events a, window_bounds w
   where a.operator_id = $1 and a.action = 'lead.lost'
     and a.created_at >= w.from_at and a.created_at < w.to_at) as lost,
  (select count(*)::int from audit_events a, window_bounds w
   where a.operator_id = $1 and a.action = 'answer.flagged_incorrect'
     and a.created_at >= w.from_at and a.created_at < w.to_at) as incorrect_answers,
  (select count(*)::int from handoffs h, window_bounds w
   where h.operator_id = $1
     and h.reason in ('payment_or_dispute', 'safety_or_accident')
     and h.created_at >= w.from_at and h.created_at < w.to_at) as complaints
`

export async function getMetrics(
  run: QueryRunner,
  operatorId: string,
  from: Date,
  /** Defaults to the database's own `now()`. See the note in the query. */
  to?: Date,
): Promise<Metrics> {
  const toParam = to?.toISOString() ?? null
  const [row] = await run(METRICS_SQL, [operatorId, from.toISOString(), toParam])

  const reasons = await run(
    `select coalesce(a.data ->> 'reason', 'other') as reason, count(*)::int as n
     from audit_events a
     where a.operator_id = $1 and a.action = 'lead.lost'
       and a.created_at >= $2::timestamptz
       and a.created_at < coalesce($3::timestamptz, now())
     group by 1 order by n desc`,
    [operatorId, from.toISOString(), toParam],
  )

  const num = (key: string): number | null =>
    row?.[key] == null ? null : Number(row[key])

  return {
    from,
    to: to ?? new Date(),
    enquiries: Number(row?.['enquiries'] ?? 0),
    firstResponseSeconds: num('first_response_seconds'),
    qualificationRate: num('qualification_rate'),
    qualifiedLeads: Number(row?.['qualified_leads'] ?? 0),
    handoffs: Number(row?.['handoffs'] ?? 0),
    timeToSalespersonSeconds: num('time_to_salesperson_seconds'),
    quoteRequests: Number(row?.['quote_requests'] ?? 0),
    quotesSent: Number(row?.['quotes_sent'] ?? 0),
    won: Number(row?.['won'] ?? 0),
    lost: Number(row?.['lost'] ?? 0),
    lostReasons: reasons.map((r) => ({
      reason: r['reason'] as string,
      count: Number(r['n']),
    })),
    incorrectAnswers: Number(row?.['incorrect_answers'] ?? 0),
    complaints: Number(row?.['complaints'] ?? 0),
  }
}

/** Seconds as something a person reads at a glance. */
export function formatDuration(seconds: number | null): string {
  if (seconds === null) return '—'
  if (seconds < 90) return `${Math.round(seconds)}s`
  if (seconds < 5400) return `${Math.round(seconds / 60)} min`
  return `${(seconds / 3600).toFixed(1)} h`
}

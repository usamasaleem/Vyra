import { generateKeyPairSync } from 'node:crypto'
import type { QueryRunner } from '../runner.js'

/**
 * What reaches a person's phone, and when.
 *
 * The sweep reads the state everything else already writes — handoffs,
 * bookings waiting for a yes, work the agent could not finish — and turns each
 * new situation into one alert. Nothing that raises a handoff has to remember
 * to alert anybody, which is the only way every one of them does.
 *
 * Only the last day counts. An alert is about somebody waiting now; the first
 * deploy should not wake a salesperson for a week of history.
 */

export type PushKeys = { publicKey: string; privateKey: string }

/** The worker's first start makes the pair; every later call reads it. */
export async function ensurePushKeys(run: QueryRunner): Promise<PushKeys> {
  const [existing] = await run(`select public_key, private_key from push_keys where id = 1`, [])
  if (existing !== undefined) {
    return { publicKey: existing['public_key'] as string, privateKey: existing['private_key'] as string }
  }
  // P-256, as the push services require: the public key as the uncompressed
  // point and the private key as the raw scalar, both base64url.
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const pub = publicKey.export({ format: 'jwk' })
  const priv = privateKey.export({ format: 'jwk' })
  const point = Buffer.concat([
    Buffer.from([4]), Buffer.from(pub.x!, 'base64url'), Buffer.from(pub.y!, 'base64url'),
  ])
  await run(
    `insert into push_keys (id, public_key, private_key) values (1, $1, $2) on conflict do nothing`,
    [point.toString('base64url'), priv.d!],
  )
  // Two workers starting together: whichever inserted first wins, both use it.
  const [row] = await run(`select public_key, private_key from push_keys where id = 1`, [])
  return { publicKey: row!['public_key'] as string, privateKey: row!['private_key'] as string }
}

/** Null until the worker has started once. */
export async function pushPublicKey(run: QueryRunner): Promise<string | null> {
  const [row] = await run(`select public_key from push_keys where id = 1`, [])
  return (row?.['public_key'] as string) ?? null
}

export async function savePushSubscription(
  run: QueryRunner,
  input: {
    operatorId: string; membershipId: string
    endpoint: string; p256dh: string; auth: string; userAgent: string | null
  },
): Promise<void> {
  await run(
    `insert into push_subscriptions (operator_id, membership_id, endpoint, p256dh, auth, user_agent)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (endpoint) do update
       set operator_id = excluded.operator_id, membership_id = excluded.membership_id,
           p256dh = excluded.p256dh, auth = excluded.auth, user_agent = excluded.user_agent`,
    [input.operatorId, input.membershipId, input.endpoint, input.p256dh, input.auth, input.userAgent],
  )
}

export async function removePushSubscription(
  run: QueryRunner,
  input: { operatorId: string; endpoint: string },
): Promise<void> {
  await run(`delete from push_subscriptions where operator_id = $1 and endpoint = $2`,
    [input.operatorId, input.endpoint])
}

export type AlertDevice = { endpoint: string; userAgent: string | null; createdAt: Date; lastSentAt: Date | null }

export async function alertDevicesFor(
  run: QueryRunner,
  input: { operatorId: string; membershipId: string },
): Promise<AlertDevice[]> {
  const rows = await run(
    `select endpoint, user_agent, created_at, last_sent_at from push_subscriptions
     where operator_id = $1 and membership_id = $2 order by created_at`,
    [input.operatorId, input.membershipId],
  )
  return rows.map((r) => ({
    endpoint: r['endpoint'] as string,
    userAgent: (r['user_agent'] as string) ?? null,
    createdAt: new Date(r['created_at'] as string),
    lastSentAt: r['last_sent_at'] == null ? null : new Date(r['last_sent_at'] as string),
  }))
}

/** One alert, to the person asking, so they can see it arrive. */
export async function requestTestAlert(
  run: QueryRunner,
  input: { operatorId: string; membershipId: string },
): Promise<void> {
  await run(
    `insert into team_alerts (operator_id, membership_id, kind, subject, title, body, url)
     values ($1, $2, 'test', gen_random_uuid()::text, 'Alerts are on',
             'This is how Vyra tells you a customer is waiting on you.', '/')`,
    [input.operatorId, input.membershipId],
  )
}

/** Who the customer is, as a salesperson would recognise them. */
const WHO = `coalesce(nullif(trim(c.display_name), ''), c.channel_identifier)`

const ENQUEUE_SQL = [
  /**
   * A handoff nobody has picked up. Keyed on its priority as well, so one
   * raised again is silent and one raised to urgent is not.
   */
  `insert into team_alerts (operator_id, conversation_id, kind, subject, title, body, url)
   select h.operator_id, h.conversation_id, 'handoff', h.id || ':' || h.priority,
          case h.priority when 'urgent' then 'Urgent: ' else '' end || ${WHO} || ' needs a person',
          left(h.summary, 240), '/conversations/' || h.conversation_id
   from handoffs h
   join conversations v on v.id = h.conversation_id and v.operator_id = h.operator_id
   join contacts c on c.id = v.contact_id and c.operator_id = v.operator_id
   where h.state in ('waiting', 'escalated') and h.accepted_at is null
     and h.updated_at > now() - interval '1 day'
   on conflict do nothing`,

  /** The same handoff, past the time the operator promised to answer in. */
  `insert into team_alerts (operator_id, conversation_id, kind, subject, title, body, url)
   select h.operator_id, h.conversation_id, 'handoff_late', h.id::text,
          'Still waiting: ' || ${WHO},
          'Nobody has picked this up for ' || floor(extract(epoch from now() - h.created_at) / 60)::int
            || ' minutes. ' || left(h.summary, 200),
          '/conversations/' || h.conversation_id
   from handoffs h
   join conversations v on v.id = h.conversation_id and v.operator_id = h.operator_id
   join contacts c on c.id = v.contact_id and c.operator_id = v.operator_id
   where h.state in ('waiting', 'escalated') and h.accepted_at is null
     and h.due_at < now() and h.due_at > now() - interval '1 day'
   on conflict do nothing`,

  /** A customer said yes and the booking is over the agent's limits. */
  `insert into team_alerts (operator_id, conversation_id, kind, subject, title, body, url)
   select b.operator_id, b.conversation_id, 'booking', b.id::text,
          'Booking to confirm: ' || ${WHO},
          coalesce(trim(ve.make || ' ' || ve.model), 'Car') || ', '
            || to_char(q.start_date::date, 'FMDD Mon') || ' to '
            || to_char(coalesce(q.end_date, q.start_date)::date, 'FMDD Mon') || ', '
            || q.currency || ' ' || to_char(q.total_minor / 100, 'FM999,999,999')
            || '. The customer is waiting for your yes.',
          '/bookings'
   from bookings b
   join quotes q on q.id = b.quote_id and q.operator_id = b.operator_id
   left join vehicles ve on ve.id = q.vehicle_id
   join conversations v on v.id = b.conversation_id and v.operator_id = b.operator_id
   join contacts c on c.id = v.contact_id and c.operator_id = v.operator_id
   where b.state = 'requested' and b.requested_at > now() - interval '1 day'
   on conflict do nothing`,

  /** The same booking, still unanswered after the operator's handoff time. */
  `insert into team_alerts (operator_id, conversation_id, kind, subject, title, body, url)
   select b.operator_id, b.conversation_id, 'booking_late', b.id::text,
          'Still to confirm: ' || ${WHO} || '''s booking',
          'Waiting ' || floor(extract(epoch from now() - b.requested_at) / 60)::int
            || ' minutes for a yes. The car is not held while it waits.',
          '/bookings'
   from bookings b
   join operators o on o.id = b.operator_id
   join conversations v on v.id = b.conversation_id and v.operator_id = b.operator_id
   join contacts c on c.id = v.contact_id and c.operator_id = v.operator_id
   where b.state = 'requested'
     and b.requested_at + make_interval(mins => o.handoff_sla_minutes) < now()
     and b.requested_at > now() - interval '1 day'
   on conflict do nothing`,

  /**
   * Something the agent told the customer the team would do, with the
   * conversation still in its hands. Keyed on the words, so new work alerts
   * and the same work does not.
   */
  `insert into team_alerts (operator_id, conversation_id, kind, subject, title, body, url)
   select v.operator_id, v.id, 'needs_input', v.id || ':' || md5(v.next_action),
          ${WHO} || ' is waiting on an answer',
          left(regexp_replace(v.next_action, '^Waiting on you:\\s*', ''), 240),
          '/conversations/' || v.id
   from conversations v
   join contacts c on c.id = v.contact_id and c.operator_id = v.operator_id
   where v.handler_mode = 'ai' and v.next_action like 'Waiting on you:%'
     and v.updated_at > now() - interval '1 day'
   on conflict do nothing`,
]

export async function enqueueTeamAlerts(run: QueryRunner): Promise<void> {
  for (const statement of ENQUEUE_SQL) await run(statement, [])
}

export type DueAlert = {
  id: string
  title: string
  body: string
  url: string
  tag: string
  devices: Array<{ endpoint: string; p256dh: string; auth: string }>
}

export async function unsentTeamAlerts(run: QueryRunner, limit = 20): Promise<DueAlert[]> {
  const rows = await run(
    `select a.id, a.title, a.body, a.url, a.kind || ':' || a.subject as tag,
            coalesce(jsonb_agg(jsonb_build_object('endpoint', s.endpoint, 'p256dh', s.p256dh, 'auth', s.auth))
              filter (where s.id is not null), '[]'::jsonb) as devices
     from team_alerts a
     left join memberships m on m.operator_id = a.operator_id and m.active
       and (a.membership_id = m.id
            -- Everybody who answers customers; operations never replies to one.
            or (a.membership_id is null and m.role <> 'operations'))
     left join push_subscriptions s on s.membership_id = m.id and s.operator_id = a.operator_id
     where a.sent_at is null
     group by a.id
     order by a.created_at
     limit $1`,
    [limit],
  )
  return rows.map((r) => ({
    id: r['id'] as string,
    title: r['title'] as string,
    body: r['body'] as string,
    url: r['url'] as string,
    tag: r['tag'] as string,
    devices: (typeof r['devices'] === 'string' ? JSON.parse(r['devices']) : r['devices']) as DueAlert['devices'],
  }))
}

export async function markAlertSent(
  run: QueryRunner,
  input: { id: string; delivered: number; endpoints: string[] },
): Promise<void> {
  await run(`update team_alerts set sent_at = now(), delivered = $2 where id = $1`, [input.id, input.delivered])
  if (input.endpoints.length > 0) {
    await run(`update push_subscriptions set last_sent_at = now() where endpoint = any($1::text[])`,
      [input.endpoints])
  }
}

/** A device the push service says is gone: uninstalled, or permission revoked. */
export async function forgetPushDevice(run: QueryRunner, endpoint: string): Promise<void> {
  await run(`delete from push_subscriptions where endpoint = $1`, [endpoint])
}

export type SentAlert = { title: string; body: string; url: string; sentAt: Date | null; delivered: number | null }

/** What went out lately, so "did anybody get told?" has an answer. */
export async function recentTeamAlerts(
  run: QueryRunner,
  input: { operatorId: string; limit?: number },
): Promise<SentAlert[]> {
  const rows = await run(
    `select title, body, url, sent_at, delivered from team_alerts
     where operator_id = $1 and kind <> 'test'
     order by created_at desc limit $2`,
    [input.operatorId, input.limit ?? 15],
  )
  return rows.map((r) => ({
    title: r['title'] as string,
    body: r['body'] as string,
    url: r['url'] as string,
    sentAt: r['sent_at'] == null ? null : new Date(r['sent_at'] as string),
    delivered: r['delivered'] == null ? null : Number(r['delivered']),
  }))
}

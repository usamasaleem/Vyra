import type { QueryRunner } from '../runner.js'

/**
 * Scheduling, cancelling and sending a chase.
 *
 * Section 11 of the MVP. The rule that shapes every function here is "send only
 * approved automated follow-ups": a follow-up is an unprompted message to
 * somebody who did not reply, which is the single message most likely to be
 * reported as spam. So the wording comes from the operator's published policy,
 * and with no published policy nothing is sent.
 */

/** WhatsApp free-form replies are only permitted inside this window. */
const CUSTOMER_SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000

/**
 * The customer is waiting on the team, not the other way round.
 *
 * Simulated, and exactly as bad as it sounds: the agent said "I'm checking
 * both with the team" about the kilometres and Abu Dhabi, then sent "Still
 * thinking it over?" four times to somebody who had said, each time, that
 * they were waiting for that answer. A chase asks whether they have decided;
 * they cannot decide until we answer. An open handoff or work the agent
 * recorded for a person means the next message is ours to send.
 */
const WAITING_ON_THE_TEAM = `(
  exists (select 1 from handoffs h
          where h.conversation_id = v.id and h.operator_id = v.operator_id
            and h.state in ('waiting', 'accepted', 'escalated'))
  or coalesce(v.next_action, '') like 'Waiting on you:%'
)`

export type ScheduledFollowUp = {
  followUpId: string | null
  /** False when one was already scheduled — a repeat is not a second chase. */
  scheduled: boolean
  dueAt: Date | null
}

/**
 * Schedule a chase for a conversation waiting on the customer.
 *
 * Silently does nothing when the conversation is not eligible, rather than
 * failing: the callers are ordinary turn completions, and a conversation that
 * a person has taken over or a customer has opted out of is simply not one to
 * chase. Every one of those conditions is in the predicate rather than checked
 * beforehand, so no caller can skip them.
 */
export async function scheduleFollowUp(
  run: QueryRunner,
  input: {
    operatorId: string
    conversationId: string
    reason: string
    /** From the operator's published follow-up policy. */
    afterMinutes: number
    attempt?: number
  },
): Promise<ScheduledFollowUp> {
  const rows = await run(
    `insert into follow_ups (operator_id, conversation_id, reason, attempt, due_at)
     select $1, v.id, $3, $5, now() + make_interval(mins => $4)
     from conversations v
     join contacts c on c.id = v.contact_id and c.operator_id = v.operator_id
     where v.id = $2 and v.operator_id = $1
       -- Section 11: stop automation after takeover, opt-out, win or loss.
       and v.handler_mode = 'ai'
       and c.opted_out_at is null
       and v.sales_stage not in ('won', 'lost')
       and not ${WAITING_ON_THE_TEAM}
     on conflict do nothing
     returning id, due_at`,
    [input.operatorId, input.conversationId, input.reason, input.afterMinutes, input.attempt ?? 1],
  )

  const row = rows[0]
  return {
    followUpId: (row?.['id'] as string) ?? null,
    scheduled: row !== undefined,
    dueAt: row?.['due_at'] == null ? null : new Date(row['due_at'] as string),
  }
}

/**
 * Stop chasing.
 *
 * Called when the customer replies, when somebody takes over, on an opt-out,
 * and when a lead is won or lost. Returns the count so a caller can log that
 * something was actually stopped — a cancel that silently matched nothing is
 * how a customer keeps getting chased after saying stop.
 */
export async function cancelFollowUps(
  run: QueryRunner,
  input: { operatorId: string; conversationId: string; reason: string },
): Promise<{ cancelled: number }> {
  const rows = await run(
    `update follow_ups
     set state = 'cancelled', cancelled_reason = $3, cancelled_at = now(), updated_at = now()
     where operator_id = $1 and conversation_id = $2 and state = 'scheduled'
     returning id`,
    [input.operatorId, input.conversationId, input.reason],
  )
  return { cancelled: rows.length }
}

/**
 * Chases that came due while the team owed the customer an answer.
 *
 * Cancelled rather than left waiting. Kept, they would fire the moment the
 * team answered — "Still thinking it over?" straight after the answer they
 * were waiting for. The next reply schedules a fresh one if it is needed.
 */
export async function cancelFollowUpsWaitingOnTheTeam(run: QueryRunner): Promise<{ cancelled: number }> {
  const rows = await run(
    `update follow_ups f
     set state = 'cancelled', cancelled_reason = 'waiting on the team', cancelled_at = now(), updated_at = now()
     from conversations v
     where v.id = f.conversation_id and v.operator_id = f.operator_id
       and f.state = 'scheduled' and f.due_at <= now()
       and ${WAITING_ON_THE_TEAM}
     returning f.id`,
    [],
  )
  return { cancelled: rows.length }
}

export type DueFollowUp = {
  id: string
  operatorId: string
  conversationId: string
  attempt: number
  reason: string
  /** The operator's approved follow-up policy, or null if none is published. */
  approvedPolicy: string | null
  /** Whether a free-form message may still be sent at all. */
  insideWindow: boolean
  lastCustomerMessageAt: Date | null
}

/**
 * Follow-ups that have come due and are still eligible.
 *
 * The eligibility conditions are re-evaluated here rather than trusted from
 * scheduling time, because everything that matters may have changed in the
 * hours since: a person took over, the customer opted out, the lead was won.
 * Section 18.10 makes the same argument about the sending window — check it at
 * the moment of dispatch, never when the reply was scheduled.
 */
export async function findDueFollowUps(
  run: QueryRunner,
  limit = 20,
): Promise<DueFollowUp[]> {
  const rows = await run(
    `select f.id, f.operator_id, f.conversation_id, f.attempt, f.reason,
            v.last_customer_message_at,
            k.answer as approved_policy
     from follow_ups f
     join conversations v on v.id = f.conversation_id and v.operator_id = f.operator_id
     join contacts c on c.id = v.contact_id and c.operator_id = v.operator_id
     left join lateral (
       select answer from knowledge_entries
       -- The wording for this attempt, not the rule. 'follow-up-timing'
       -- describes when to chase and was briefly what got sent, which is how a
       -- policy note came within hours of reaching a customer.
       --
       -- A second chase has wording of its own, because the same sentence
       -- twice is the thing that makes a follow-up read as a machine. Live:
       -- "Still thinking about those dates?" arrived at 7:02 and again at
       -- 7:32, word for word. A person's second nudge says something new.
       --
       -- With nothing published for the later attempt the chase becomes a task
       -- for somebody rather than a repeat, which is section 11's rule working
       -- rather than being worked around.
       where operator_id = f.operator_id
         and topic = case when f.attempt <= 1 then 'follow-up-message'
                          else 'follow-up-message-2' end
         and published_at is not null
         and effective_from <= now() and (effective_to is null or effective_to > now())
       order by version desc limit 1
     ) k on true
     where f.state = 'scheduled'
       and f.due_at <= now()
       and v.handler_mode = 'ai'
       and c.opted_out_at is null
       and v.sales_stage not in ('won', 'lost')
       -- Live: "Still thinking it over? Happy to answer anything about the car
       -- or the dates whenever you are ready" went to a customer six minutes
       -- after they booked a Ferrari. Nothing here knew a booking existed,
       -- because until this week there was no such thing. Someone waiting on
       -- your team is worse still — they said yes and the chase asks whether
       -- they have made up their mind.
       and v.booking_status not in ('pending', 'confirmed')
       and not ${WAITING_ON_THE_TEAM}
     order by f.due_at
     limit $1`,
    [limit],
  )

  return rows.map((r) => {
    const lastInbound = r['last_customer_message_at'] == null
      ? null
      : new Date(r['last_customer_message_at'] as string)
    return {
      id: r['id'] as string,
      operatorId: r['operator_id'] as string,
      conversationId: r['conversation_id'] as string,
      attempt: Number(r['attempt']),
      reason: r['reason'] as string,
      approvedPolicy: (r['approved_policy'] as string) ?? null,
      insideWindow:
        lastInbound !== null && Date.now() - lastInbound.getTime() < CUSTOMER_SERVICE_WINDOW_MS,
      lastCustomerMessageAt: lastInbound,
    }
  })
}

export async function markFollowUpSent(
  run: QueryRunner,
  input: { followUpId: string; operatorId: string; body: string; messageId: string | null },
): Promise<void> {
  await run(
    `update follow_ups
     set state = 'sent', sent_body = $3, sent_message_id = $4::uuid, sent_at = now(),
         updated_at = now()
     where id = $1 and operator_id = $2 and state = 'scheduled'`,
    [input.followUpId, input.operatorId, input.body, input.messageId],
  )
}

/**
 * A follow-up that cannot be sent automatically becomes a person's job.
 *
 * Two reasons reach here and neither is fixed by retrying: the 24-hour window
 * has closed, so free-form sending is not permitted at all, or the operator has
 * published no follow-up policy, so there is no approved wording to send.
 */
export async function markFollowUpNeedsAPerson(
  run: QueryRunner,
  input: { followUpId: string; operatorId: string; reason: string },
): Promise<void> {
  await run(
    `update follow_ups
     set state = 'needs_a_person', cancelled_reason = $3, updated_at = now()
     where id = $1 and operator_id = $2 and state = 'scheduled'`,
    [input.followUpId, input.operatorId, input.reason],
  )
}

export type OverdueFollowUp = {
  id: string
  conversationId: string
  reason: string
  state: string
  dueAt: Date
  minutesLate: number
  customerName: string | null
  whatsappNumber: string
}

/** What the inbox shows: chases that need a person, and ones running late. */
export async function listFollowUpsNeedingAttention(
  run: QueryRunner,
  operatorId: string,
): Promise<OverdueFollowUp[]> {
  const rows = await run(
    `select f.id, f.conversation_id, f.reason, f.state::text as state, f.due_at,
            extract(epoch from now() - f.due_at)::int / 60 as minutes_late,
            c.display_name, c.channel_identifier
     from follow_ups f
     join conversations v on v.id = f.conversation_id and v.operator_id = f.operator_id
     join contacts c on c.id = v.contact_id and c.operator_id = v.operator_id
     where f.operator_id = $1
       and (f.state = 'needs_a_person' or (f.state = 'scheduled' and f.due_at < now()))
     order by f.due_at
     limit 50`,
    [operatorId],
  )

  return rows.map((r) => ({
    id: r['id'] as string,
    conversationId: r['conversation_id'] as string,
    reason: r['reason'] as string,
    state: r['state'] as string,
    dueAt: new Date(r['due_at'] as string),
    minutesLate: Number(r['minutes_late'] ?? 0),
    customerName: (r['display_name'] as string) ?? null,
    whatsappNumber: r['channel_identifier'] as string,
  }))
}

/**
 * Letting go of a chase nobody is going to send.
 *
 * `needs_a_person` is a real outcome rather than a failure, but it had no way
 * out: thirteen of them accumulated with no screen to see them on and no way
 * to clear one. A queue you cannot empty stops being a queue and becomes
 * wallpaper, and then the real one in it is invisible too.
 */
export async function dropFollowUp(
  run: QueryRunner,
  input: { followUpId: string; operatorId: string; reason: string },
): Promise<{ dropped: boolean }> {
  const rows = await run(
    `update follow_ups
     set state = 'cancelled', cancelled_reason = $3, cancelled_at = now(), updated_at = now()
     where id = $1 and operator_id = $2 and state in ('needs_a_person', 'scheduled')
     returning id`,
    [input.followUpId, input.operatorId, input.reason],
  )
  return { dropped: rows.length > 0 }
}

import { POLICY_TOPICS } from '@vyra/contracts'
import type { QueryRunner } from '../runner.js'

/**
 * What is still missing before this agent is any use.
 *
 * Written because a new operator's first hour is spent guessing. Everything an
 * empty Vyra does is technically correct — it has no cars, so it says it will
 * check with the team; it has no answers, so it says it will check with the
 * team — and the result looks like a working product doing nothing. Somebody
 * has to be told that three specific things are missing and that until they
 * exist, every reply will be a deferral.
 *
 * Ordered by what blocks what. A number before cars, cars before rates, rates
 * before automatic replies. The last step is deliberately last: switching the
 * agent on with nothing behind it is how an operator decides this does not
 * work.
 */
export type SetupStep = {
  key: string
  title: string
  /** What it costs to skip, in the operator's terms rather than ours. */
  why: string
  done: boolean
  /** What is true right now. Null when there is nothing worth saying. */
  detail: string | null
  href: string | null
  /**
   * True when the agent cannot do its job without it, as opposed to doing it
   * less well. The distinction is the difference between "not ready" and "not
   * finished", and an operator deserves to know which they are looking at.
   */
  blocking: boolean
}

export type SetupState = {
  steps: SetupStep[]
  /** Steps that stop the agent working at all. Zero means it can sell. */
  blocked: number
  remaining: number
}

const SURVEY_SQL = `
  select
    (select count(*)::int from whatsapp_accounts w where w.operator_id = $1)      as numbers,
    (select count(*)::int from vehicles v
      where v.operator_id = $1 and v.active and v.provenance = 'operator_confirmed') as cars,
    (select count(*)::int from vehicles v
      where v.operator_id = $1 and v.active
        and jsonb_typeof(v.photo_urls) = 'array'
        and jsonb_array_length(v.photo_urls) > 0)                                 as cars_with_photos,
    (select count(distinct r.vehicle_id)::int from vehicle_rates r
      where r.operator_id = $1 and r.effective_to is null)                        as priced,
    -- Only the policy topics. Counting every published topic meant the four
    -- automated messages read as four answered policy questions, so a pilot
    -- with none of the six answered was told it had four of them.
    (select count(distinct k.topic)::int from knowledge_entries k
      where k.operator_id = $1 and k.published_at is not null
        and k.topic = any($2::text[])
        and k.effective_from <= now()
        and (k.effective_to is null or k.effective_to > now()))                   as answered,
    (select count(distinct k.confirmed_by)::int from knowledge_entries k
      where k.operator_id = $1 and k.published_at is not null
        and k.confirmed_by is not null)                                           as confirmers,
    (select count(distinct k.topic)::int from knowledge_entries k
      where k.operator_id = $1 and k.published_at is not null
        and k.topic in ('follow-up-message', 'follow-up-message-2')
        and (k.effective_to is null or k.effective_to > now()))                   as follow_up_wordings,
    (select count(distinct k.topic)::int from knowledge_entries k
      where k.operator_id = $1 and k.published_at is not null
        and k.topic in ('greeting', 'out-of-hours')
        and (k.effective_to is null or k.effective_to > now()))                   as sent_on_its_own,
    -- Anybody whose role replies to customers and has no name to sign with.
    -- They cannot send at all: the send path refuses rather than going out
    -- unsigned, which is right and invisible until somebody tries.
    (select count(*)::int from memberships m
      where m.operator_id = $1 and m.active
        and m.role in ('admin', 'manager', 'salesperson')
        and (m.display_name is null or btrim(m.display_name) = ''))               as unnamed_people,
    o.service_hours is not null                                                   as hours_set,
    o.availability_calendar_complete,
    o.ai_sending_enabled,
    o.fallback_owner_membership_id
  from operators o
  where o.id = $1
`

/** Plural without a special case at every call site. */
const count = (n: number, one: string, many = `${one}s`): string =>
  `${n} ${n === 1 ? one : many}`

export async function getSetupState(
  run: QueryRunner,
  operatorId: string,
): Promise<SetupState> {
  const [row] = await run(SURVEY_SQL, [operatorId, POLICY_TOPICS as unknown as string[]])
  const n = (key: string): number => Number(row?.[key] ?? 0)

  const topics = POLICY_TOPICS.length
  const answered = n('answered')

  const steps: SetupStep[] = [
    {
      key: 'whatsapp',
      title: 'Connect a WhatsApp number',
      why: 'Nothing reaches this inbox until a number is linked, and nothing is sent without credentials of your own — Meta issues those per business.',
      done: n('numbers') > 0,
      detail: n('numbers') > 0 ? 'Connected.' : 'No number linked yet.',
      href: '/settings/whatsapp',
      blocking: true,
    },
    {
      key: 'fleet',
      title: 'Add your cars',
      why: 'With an empty fleet the agent cannot name a single car, so every enquiry becomes a question for a person.',
      done: n('cars') > 0,
      detail: n('cars') > 0 ? `${count(n('cars'), 'car')} on file.` : 'No cars yet.',
      href: '/rates',
      blocking: true,
    },
    {
      key: 'rates',
      title: 'Confirm a day rate for each car',
      why: 'A car with no confirmed rate cannot be quoted. The agent will say so honestly rather than guess, which is correct and useless.',
      done: n('cars') > 0 && n('priced') >= n('cars'),
      detail: n('cars') === 0
        ? null
        : `${count(n('priced'), 'car')} priced, of ${n('cars')}.`,
      href: '/rates',
      blocking: true,
    },
    {
      key: 'answers',
      title: 'Answer the policy questions',
      why: 'Deposit, kilometres, licence requirements, delivery. These are what a customer asks before they will commit, and the agent will not invent one.',
      done: answered >= topics,
      detail: `${answered} of ${topics} answered.`,
      href: '/knowledge',
      blocking: true,
    },
    {
      key: 'names',
      title: 'Put a name to everybody who replies',
      why: 'Every message a person sends is signed with their name, which is the only way somebody on WhatsApp can tell a colleague from the assistant. Nobody without one can send at all — the path refuses rather than going out unsigned — and they find that out the moment they try to answer a customer.',
      done: n('unnamed_people') === 0,
      detail: n('unnamed_people') === 0
        ? 'Everyone who replies has one.'
        : `${count(n('unnamed_people'), 'person', 'people')} cannot reply yet.`,
      href: '/team',
      blocking: true,
    },
    {
      key: 'automated-messages',
      title: 'Write the greeting and the out-of-hours reply',
      why: 'Both go out with nobody watching, in your words and only your words. An unwritten one is not sent at all, so a first-time customer gets no welcome and somebody writing at 3am is told nothing about when a person will see it.',
      done: n('sent_on_its_own') >= 2,
      detail: n('sent_on_its_own') >= 2
        ? 'Both written.'
        : `${n('sent_on_its_own')} of 2 written.`,
      href: '/messages',
      blocking: false,
    },
    {
      key: 'hours',
      title: 'Say when somebody is at the desk',
      why: 'Without hours the out-of-hours reply never fires, however well it is written — nothing knows the desk is empty. The agent answers around the clock either way; this is about your people.',
      done: row?.['hours_set'] === true,
      detail: row?.['hours_set'] === true ? 'Set.' : 'Not set, so the out-of-hours reply never sends.',
      href: '/messages',
      blocking: false,
    },
    {
      key: 'calendar',
      title: 'Say whether you keep the calendar current',
      why: 'Until you do, an empty calendar means "nobody knows" rather than "free", and every question about a date goes to one of your people. Say it and the agent answers availability itself — but only say it if every car going off the road really does land on that calendar.',
      done: row?.['availability_calendar_complete'] === true,
      detail: row?.['availability_calendar_complete'] === true
        ? 'The agent can answer availability itself.'
        : 'Every availability question becomes a task for a person.',
      href: '/availability',
      blocking: false,
    },
    {
      key: 'follow-up-wording',
      title: 'Write what a follow-up says — both of them',
      why: 'The agent chases a quiet customer twice, in your words exactly as you write them. The second has to say something the first did not; the same sentence twice is what makes a follow-up read as a machine. Either one missing becomes a task for a person instead of a message.',
      done: n('follow_up_wordings') >= 2,
      detail: n('follow_up_wordings') === 0
        ? 'Neither published.'
        : n('follow_up_wordings') === 1
        ? 'One published, one to go — a second chase currently becomes a task.'
        : 'Both published.',
      href: '/messages',
      blocking: false,
    },
    {
      key: 'photos',
      title: 'Add photographs',
      why: 'Customers ask to see the car more often than they ask anything else, and a reply with pictures does more than a reply describing them.',
      done: n('cars') > 0 && n('cars_with_photos') >= n('cars'),
      detail: n('cars') === 0
        ? null
        : `${count(n('cars_with_photos'), 'car')} with photographs, of ${n('cars')}.`,
      href: '/rates',
      blocking: false,
    },
    {
      key: 'fallback',
      title: 'Name who hears about an unanswered handoff',
      why: 'When nobody accepts a handoff in time, the escalation goes to this person. Leave it and it goes to your longest-standing admin, which is a guess at what you would have chosen.',
      done: row?.['fallback_owner_membership_id'] != null,
      detail: row?.['fallback_owner_membership_id'] == null
        ? 'Nobody named — escalations are going to your longest-standing admin.'
        : null,
      href: '/settings',
      blocking: false,
    },
    {
      key: 'autosend',
      title: 'Let the agent reply on its own',
      why: 'Last on purpose. Until this is on the agent drafts and a person sends; switching it on with nothing behind it is how an operator decides this does not work.',
      done: row?.['ai_sending_enabled'] === true,
      detail: row?.['ai_sending_enabled'] === true ? 'On.' : 'Drafting only.',
      href: '/',
      blocking: false,
    },
  ]

  return {
    steps,
    blocked: steps.filter((s) => s.blocking && !s.done).length,
    remaining: steps.filter((s) => !s.done).length,
  }
}

/**
 * Who stands behind the published answers.
 *
 * Not a step, because there is no state in which it is finished. It is here
 * because `provenance` stopped being able to answer this: publishing sets it to
 * operator_confirmed whatever the content was, so the only remaining evidence
 * that a real person agreed to an answer is the name they signed it with. This
 * pilot's are all signed "DEMO DATA — not confirmed by an operator", and the
 * agent has been stating them to customers as fact.
 */
export async function whoConfirmedTheAnswers(
  run: QueryRunner,
  operatorId: string,
): Promise<Array<{ confirmedBy: string; topics: number }>> {
  const rows = await run(
    `select coalesce(confirmed_by, 'nobody named') as confirmed_by,
            count(distinct topic)::int as topics
     from knowledge_entries
     where operator_id = $1 and published_at is not null
       and (effective_to is null or effective_to > now())
     group by 1
     order by 2 desc`,
    [operatorId],
  )
  return rows.map((r) => ({
    confirmedBy: r['confirmed_by'] as string,
    topics: Number(r['topics']),
  }))
}

import type { QueryRunner } from '../runner.js'
import { getSetupState, type SetupStep } from './setup.js'

/**
 * Whether the agent can be trusted to sell and book without waiting on anyone.
 *
 * Autonomous is a promise to customers, not a mood: every question they ask
 * before committing has an answer, every date has a calendar behind it, every
 * yes can be confirmed, and when something does need a person, a person hears
 * about it. Each of those is checked here from what is actually on file, and
 * the switch will not turn on while one that matters is missing.
 *
 * Some things are shown and not required, because the pieces that would take
 * them off a person's desk do not exist yet — documents, payments, and
 * messages after 24 hours of silence. An operator switching on should know
 * exactly what still reaches their team.
 */
export type ReadinessItem = SetupStep & {
  /** Shown so nobody is surprised, never blocking: the automation does not exist yet. */
  later?: true
}

export type AutonomyState = {
  on: boolean
  setAt: Date | null
  setBy: string | null
  items: ReadinessItem[]
  /** Blocking items not done. Zero means it may be switched on. */
  missing: number
}

const FROM_SETUP = new Set(['whatsapp', 'fleet', 'rates', 'answers', 'names', 'calendar', 'autosend', 'follow-up-wording', 'automated-messages'])
/** Setup calls these nice to have; selling alone needs them. */
const REQUIRED_HERE = new Set(['calendar', 'autosend'])

export async function getAutonomyState(run: QueryRunner, operatorId: string): Promise<AutonomyState> {
  const setup = await getSetupState(run, operatorId)
  const [row] = await run(
    `select o.autonomous, o.autonomous_set_at, o.auto_confirm_bookings, o.auto_confirm_limit_minor,
            o.auto_confirm_max_days, o.hold_minutes, jsonb_array_length(coalesce(o.discount_tiers, '[]'::jsonb)) as tiers,
            coalesce(m.display_name, m.id::text) as set_by,
            (select count(*)::int from push_subscriptions s
              join memberships p on p.id = s.membership_id and p.active and p.role <> 'operations'
              where s.operator_id = o.id) as alert_devices
     from operators o
     left join memberships m on m.id = o.autonomous_set_by_membership_id
     where o.id = $1`,
    [operatorId],
  )
  const n = (key: string) => Number(row?.[key] ?? 0)

  const fromSetup: ReadinessItem[] = setup.steps
    .filter((s) => FROM_SETUP.has(s.key))
    .map((s) => (REQUIRED_HERE.has(s.key) ? { ...s, blocking: true } : s))

  const limit = row?.['auto_confirm_limit_minor']
  const days = row?.['auto_confirm_max_days']
  const own: ReadinessItem[] = [
    {
      key: 'confirms',
      title: 'Let the agent confirm bookings itself',
      why: 'Without it every yes waits on Bookings for a person — the opposite of autonomous.',
      done: row?.['auto_confirm_bookings'] === true,
      detail: row?.['auto_confirm_bookings'] === true ? 'On.' : 'Off: every booking waits for a person.',
      href: '/settings',
      blocking: true,
    },
    {
      key: 'ceiling',
      title: 'Set the ceiling above which a booking still waits for you',
      why: 'Autonomous should not mean a 60-day, six-figure booking goes through with nobody looking. Above the ceiling it is quoted and waits on Bookings, and your phone is told.',
      done: limit != null && days != null,
      detail: limit != null && days != null
        ? `Up to ${days} days and AED ${(Number(limit) / 100).toLocaleString('en-US')}.`
        : 'No ceiling set.',
      href: '/settings',
      blocking: true,
    },
    {
      key: 'alerts',
      title: 'Turn on alerts on at least one phone',
      why: 'The few things that still need a person — an accident, a dispute, a booking over the ceiling — are only as fast as somebody hearing about them.',
      done: n('alert_devices') > 0,
      detail: n('alert_devices') > 0 ? `${n('alert_devices')} device${n('alert_devices') === 1 ? '' : 's'} with alerts on.` : 'Nobody would be told.',
      href: '/alerts',
      blocking: true,
    },
    {
      key: 'tiers',
      title: 'Decide what the agent may take off',
      why: 'When the price is the objection the agent offers your tiers and a cheaper car, and says no to anything more. Without tiers it can only offer the cheaper car.',
      done: n('tiers') > 0,
      detail: n('tiers') > 0 ? `${n('tiers')} tier${n('tiers') === 1 ? '' : 's'} set.` : 'None set.',
      href: '/settings',
      blocking: false,
    },
    {
      key: 'holds',
      title: 'Let the agent hold a car',
      why: 'A customer who needs to think keeps the car for a while instead of losing it.',
      done: row?.['hold_minutes'] != null,
      detail: row?.['hold_minutes'] != null ? `${row['hold_minutes']} minutes.` : 'Off.',
      href: '/settings',
      blocking: false,
    },
    {
      key: 'documents', later: true, blocking: false, done: false, href: null,
      title: 'Documents are still checked by a person',
      why: 'The agent collects the licence and ID and files them on the booking; a person marks them checked. Automatic checking is the next step.',
      detail: 'Coming next.',
    },
    {
      key: 'payments', later: true, blocking: false, done: false, href: null,
      title: 'Payments are still confirmed by a person',
      why: 'The agent tells the customer how to pay and records what they say; a person marks it received. A payment provider would confirm it on its own.',
      detail: 'Needs a payment provider.',
    },
    {
      key: 'templates', later: true, blocking: false, done: false, href: null,
      title: 'After 24 hours of silence, messages go to your team',
      why: 'WhatsApp only allows a message outside the 24-hour window with a template Meta has approved. Until then the day-before message and late follow-ups become tasks.',
      detail: 'Needs Meta business verification.',
    },
  ]

  const items = [...fromSetup, ...own]
  return {
    on: row?.['autonomous'] === true,
    setAt: row?.['autonomous_set_at'] == null ? null : new Date(row['autonomous_set_at'] as string),
    setBy: (row?.['set_by'] as string) ?? null,
    items,
    missing: items.filter((i) => i.blocking && !i.done).length,
  }
}

export type AutonomySwitch =
  | { ok: true; on: boolean }
  | { ok: false; missing: string[] }

/** On only when nothing blocking is missing; off at any time. */
export async function setAutonomous(
  run: QueryRunner,
  input: { operatorId: string; membershipId: string; on: boolean },
): Promise<AutonomySwitch> {
  if (input.on) {
    const state = await getAutonomyState(run, input.operatorId)
    const missing = state.items.filter((i) => i.blocking && !i.done).map((i) => i.title)
    if (missing.length > 0) return { ok: false, missing }
  }
  await run(
    `update operators set autonomous = $2, autonomous_set_by_membership_id = $3, autonomous_set_at = now(),
                          updated_at = now()
     where id = $1`,
    [input.operatorId, input.on, input.membershipId],
  )
  return { ok: true, on: input.on }
}

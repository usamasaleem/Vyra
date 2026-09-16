import Link from 'next/link'
import { getNavCounts } from '@vyra/db'
import { actorRunner } from '@/lib/db'

/**
 * The one list of places in this application.
 *
 * Before this existed each page invented its own set of links, and they drifted
 * exactly as you would expect: /rates was reachable from one page out of six,
 * /reports from two, and a conversation offered nothing but "back to inbox".
 * Nobody decided that — it is what happens when six pages each answer "where
 * can you go from here" separately.
 *
 * Destinations only. Filters that narrow the page you are already on are a
 * different thing and belong in their own row; mixing them is what let a
 * missing destination hide in a row of eight lookalike buttons.
 */
const DESTINATIONS = [
  { key: 'inbox', href: '/', label: 'Conversations' },
  { key: 'handoffs', href: '/handoffs', label: 'Handoffs' },
  { key: 'operations', href: '/operations', label: 'Operations' },
  { key: 'rates', href: '/rates', label: 'Rates' },
  { key: 'availability', href: '/availability', label: 'Availability' },
  { key: 'knowledge', href: '/knowledge', label: 'Answers' },
  { key: 'reports', href: '/reports', label: 'Reports' },
] as const

export type NavKey = (typeof DESTINATIONS)[number]['key']

export async function SiteNav({
  current,
  actor,
}: {
  current: NavKey
  /**
   * The whole actor rather than an operator id, because the badge counts are
   * now read as the restricted role and that needs to know who is asking. The
   * operator id alone was never enough to prove anything; it is a scope being
   * requested, and the policies decide whether it is held.
   */
  actor: { userId: string; operatorId: string }
}) {
  const counts = await getNavCounts(actorRunner(actor), actor.operatorId)

  /**
   * A badge appears only above zero. An empty queue and a queue of one look
   * different at a glance, which is the entire point; a "0" everywhere trains
   * people to stop reading the number.
   */
  const badge = (key: NavKey): number | null => {
    // On Conversations, because that is where somebody goes to answer one.
    if (key === 'inbox' && counts.customersWaiting > 0) return counts.customersWaiting
    if (key === 'handoffs' && counts.unclaimedHandoffs > 0) return counts.unclaimedHandoffs
    if (key === 'operations' && counts.openOperationsRequests > 0) return counts.openOperationsRequests
    return null
  }

  return (
    <nav className="sitenav" aria-label="Sections">
      {DESTINATIONS.map((d) => {
        const n = badge(d.key)
        const label = n === null ? d.label : `${d.label} (${n})`

        // The current page is not a link to itself. Rendering it as one is a
        // small lie about what clicking does.
        return d.key === current ? (
          <span key={d.key} className="sitenav-item is-current" aria-current="page">
            {label}
          </span>
        ) : (
          <Link key={d.key} className="sitenav-item" href={d.href}>
            {label}
          </Link>
        )
      })}
    </nav>
  )
}

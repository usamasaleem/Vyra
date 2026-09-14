import type { QueryRunner } from '../runner.js'

/**
 * The two numbers the navigation carries on every page.
 *
 * Both queues are things a customer is waiting on, so they belong in front of
 * whoever is looking, not only on the page that lists them. A queue nobody can
 * see is the same failure as a queue that does not exist — the recurring shape
 * of almost every bug in this system so far.
 *
 * One statement rather than two list queries, because the nav needs counts and
 * nothing else, and it runs on every authenticated page render.
 */
export type NavCounts = {
  /** Handoffs nobody has picked up. Claimed ones are somebody's problem already. */
  unclaimedHandoffs: number
  /** Questions the agent could not answer and is waiting on a person for. */
  openOperationsRequests: number
}

export async function getNavCounts(run: QueryRunner, operatorId: string): Promise<NavCounts> {
  const rows = await run(
    `select
       (select count(*) from handoffs h
         where h.operator_id = $1
           and h.state in ('waiting', 'escalated', 'accepted')
           and h.owner_membership_id is null) as unclaimed_handoffs,
       (select count(*) from operations_requests r
         where r.operator_id = $1 and r.state = 'open') as open_requests`,
    [operatorId],
  )

  const row = rows[0]
  if (row === undefined) return { unclaimedHandoffs: 0, openOperationsRequests: 0 }

  // count(*) is bigint; postgres.js hands that back as a string, PGlite as a
  // number. Number() is right for both, and these counts cannot reach a size
  // where the conversion loses anything.
  return {
    unclaimedHandoffs: Number(row['unclaimed_handoffs']),
    openOperationsRequests: Number(row['open_requests']),
  }
}

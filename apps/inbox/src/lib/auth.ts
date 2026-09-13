import { redirect } from 'next/navigation'
import { queryRunner } from './db'
import { createSupabaseServerClient } from './supabase/server'

/**
 * Build plan step 13 — who is asking, and what may they do.
 *
 * Section 18.7: verify the staff session on every call, then load active
 * operator membership and required role. Authentication establishes identity;
 * it does not establish tenant authorization. Those are separate questions and
 * conflating them is how one operator ends up reading another's conversations.
 */

export const ROLES = ['admin', 'manager', 'salesperson', 'operations'] as const
export type Role = (typeof ROLES)[number]

export type Actor = {
  userId: string
  email: string | null
  membershipId: string
  operatorId: string
  operatorName: string
  role: Role
}

const MEMBERSHIP_SQL = `
  select m.id as membership_id, m.operator_id, m.role, o.name as operator_name
  from memberships m
  join operators o on o.id = m.operator_id
  where m.user_id = $1 and m.active
  order by o.name
`

/**
 * The actor for this request, or null if there is no valid session or no
 * active membership.
 *
 * A signed-in user with no membership is authenticated and authorised for
 * nothing. That is the correct outcome, not an error: a Supabase account
 * exists the moment someone signs up, and it must grant no access to any
 * operator's data until somebody deliberately adds them to one.
 */
export async function currentActor(requestedOperatorId?: string): Promise<Actor | null> {
  const supabase = await createSupabaseServerClient()
  const { data, error } = await supabase.auth.getUser()
  if (error !== null || data.user === null) return null
  return actorForUser(data.user.id, data.user.email ?? null, requestedOperatorId)
}

/** Resolves an authenticated user to an actor, or null if they hold no membership. */
async function actorForUser(
  userId: string,
  email: string | null,
  requestedOperatorId?: string,
): Promise<Actor | null> {
  const rows = await queryRunner()(MEMBERSHIP_SQL, [userId])
  if (rows.length === 0) return null

  /**
   * A requested operator id is a scope being asked for, never proof. If the
   * caller names one, it must match a membership they actually hold; anything
   * else is refused rather than quietly falling back to their own operator.
   */
  const row =
    requestedOperatorId === undefined
      ? rows[0]
      : rows.find((r) => r['operator_id'] === requestedOperatorId)

  if (row === undefined) return null

  return {
    userId,
    email,
    membershipId: row['membership_id'] as string,
    operatorId: row['operator_id'] as string,
    operatorName: row['operator_name'] as string,
    role: row['role'] as Role,
  }
}

/**
 * For pages.
 *
 * The two failures are deliberately routed differently. Sending a signed-in
 * user back to /login would loop forever: the middleware sees a valid session
 * and bounces them straight back. It also tells them the wrong thing — their
 * credentials were fine, they simply have no access to any operator yet.
 */
export async function requireActor(requestedOperatorId?: string): Promise<Actor> {
  const supabase = await createSupabaseServerClient()
  const { data, error } = await supabase.auth.getUser()
  if (error !== null || data.user === null) redirect('/login')

  const actor = await actorForUser(data.user.id, data.user.email ?? null, requestedOperatorId)
  if (actor === null) redirect('/no-access')
  return actor
}

/**
 * Role checks, named after what they permit rather than who holds them, so a
 * call site reads as the rule it is enforcing.
 */
export const permissions = {
  /** Send a message to a customer, accept a handoff, take over. */
  canReply: (actor: Actor) => actor.role !== 'operations',
  /** Pause or resume AI replies for the operator. */
  canControlAi: (actor: Actor) => actor.role === 'admin' || actor.role === 'manager',
  /** Reassign a conversation to someone else. */
  canReassign: (actor: Actor) => actor.role === 'admin' || actor.role === 'manager',
  /** Change operator configuration. */
  canAdminister: (actor: Actor) => actor.role === 'admin',
}

export class NotPermittedError extends Error {
  constructor(action: string) {
    super(`not permitted: ${action}`)
    this.name = 'NotPermittedError'
  }
}

export function assertPermitted(
  allowed: boolean,
  action: string,
): asserts allowed is true {
  if (!allowed) throw new NotPermittedError(action)
}

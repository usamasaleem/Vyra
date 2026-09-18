import type { QueryRunner, Transactor } from '../runner.js'

/**
 * Build plan step 36 — an onboarding path that does not need somebody in the
 * database.
 *
 * Until now an operator existed because I inserted a row, and a salesperson
 * could sign in because I inserted another. That is fine for one pilot and is
 * the whole of what stands between this and a second customer.
 *
 * Two things here run privileged, and both are the same situation: a person
 * who has proved who they are and belongs to nobody yet. Row-level security is
 * written in terms of the operators a user is a member of, so at the moment
 * before their first membership exists there is no policy that can find
 * anything for them. Every other call in this file is scoped like the rest of
 * the application.
 */

/** Addresses are matched case-insensitively, so they are stored that way. */
export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase()
}

export type NewOperator = { operatorId: string; membershipId: string }

/**
 * The first person at a new operator, who is by definition its administrator.
 *
 * Privileged: there is no membership yet, so nothing scoped could insert one.
 * The user id comes from the verified session rather than from the form, which
 * is what stops this being a way to add yourself to somebody else's company.
 *
 * One transaction, because an operator with no administrator is a company
 * nobody can get into and a membership with no operator is a foreign key
 * violation. Neither is a state worth being able to reach.
 */
export async function createOperatorWithAdmin(
  transact: Transactor,
  input: { name: string; timezone: string; userId: string },
): Promise<NewOperator> {
  return transact(async (tx) => {
    const [operator] = await tx(
      `insert into operators (name, timezone) values ($1, $2) returning id`,
      [input.name.trim(), input.timezone],
    )
    const operatorId = operator!['id'] as string

    const [membership] = await tx(
      `insert into memberships (operator_id, user_id, role) values ($1, $2, 'admin')
       returning id`,
      [operatorId, input.userId],
    )

    await tx(
      `insert into audit_events (operator_id, actor_type, actor_id, action, subject_type, subject_id)
       values ($1, 'user', $2, 'operator.created', 'operator', $1)`,
      [operatorId, membership!['id'] as string],
    )

    return { operatorId, membershipId: membership!['id'] as string }
  }) as Promise<NewOperator>
}

export type PendingInvitation = {
  id: string
  operatorId: string
  operatorName: string
  role: string
}

/**
 * The invitation waiting for an address, if there is one.
 *
 * Privileged for the same reason as above and no other: this is read during
 * sign-up, before the person belongs to anything. It is keyed on the address
 * they have just authenticated with, so it discloses nothing they did not
 * already control.
 */
export async function findPendingInvitation(
  run: QueryRunner,
  email: string,
): Promise<PendingInvitation | null> {
  const rows = await run(
    `select i.id, i.operator_id, i.role::text as role, o.name as operator_name
     from operator_invitations i
     join operators o on o.id = i.operator_id
     where i.email = $1 and i.accepted_at is null and i.revoked_at is null
     order by i.created_at desc
     limit 1`,
    [normaliseEmail(email)],
  )
  const row = rows[0]
  if (row === undefined) return null
  return {
    id: row['id'] as string,
    operatorId: row['operator_id'] as string,
    operatorName: row['operator_name'] as string,
    role: row['role'] as string,
  }
}

/**
 * Joining the operator that invited you.
 *
 * The invitation is claimed and the membership created together, and the claim
 * is conditional on it still being open — so two tabs, or a revocation landing
 * in the same second, produce one membership or none rather than two.
 *
 * `on conflict do update` rather than do nothing: somebody who was deactivated
 * and then re-invited should come back at the role they were re-invited at,
 * and a silent no-op would leave them unable to sign in with no explanation.
 */
export async function acceptInvitation(
  transact: Transactor,
  input: { invitationId: string; userId: string },
): Promise<{ accepted: boolean; operatorId: string | null; membershipId: string | null }> {
  return transact(async (tx) => {
    const claimed = await tx(
      `update operator_invitations
       set accepted_at = now(), accepted_user_id = $2
       where id = $1 and accepted_at is null and revoked_at is null
       returning operator_id, role::text as role`,
      [input.invitationId, input.userId],
    )
    const invitation = claimed[0]
    if (invitation === undefined) {
      return { accepted: false, operatorId: null, membershipId: null }
    }

    const [membership] = await tx(
      `insert into memberships (operator_id, user_id, role) values ($1, $2, $3::membership_role)
       on conflict (operator_id, user_id)
       do update set role = excluded.role, active = true
       returning id`,
      [invitation['operator_id'], input.userId, invitation['role']],
    )

    return {
      accepted: true,
      operatorId: invitation['operator_id'] as string,
      membershipId: (membership?.['id'] as string) ?? null,
    }
  }) as Promise<{ accepted: boolean; operatorId: string | null; membershipId: string | null }>
}

export type TeamMember = {
  membershipId: string
  userId: string
  role: string
  active: boolean
  email: string | null
  /** What customers are told to call them. Null until somebody writes it. */
  displayName: string | null
  joinedAt: Date
}

export type TeamInvitation = {
  id: string
  email: string
  role: string
  invitedAt: Date
}

export async function listTeam(
  run: QueryRunner,
  operatorId: string,
): Promise<{ members: TeamMember[]; invited: TeamInvitation[] }> {
  const members = await run(
    `select m.id, m.user_id, m.role::text as role, m.active, m.created_at,
            m.display_name, e.email
     from memberships m
     left join public.vyra_member_emails() e on e.user_id = m.user_id
     where m.operator_id = $1
     order by m.active desc, m.role, m.created_at`,
    [operatorId],
  )

  const invited = await run(
    `select id, email, role::text as role, created_at
     from operator_invitations
     where operator_id = $1 and accepted_at is null and revoked_at is null
     order by created_at`,
    [operatorId],
  )

  return {
    members: members.map((r) => ({
      membershipId: r['id'] as string,
      userId: r['user_id'] as string,
      role: r['role'] as string,
      active: r['active'] === true,
      email: (r['email'] as string) ?? null,
      displayName: (r['display_name'] as string) ?? null,
      joinedAt: new Date(r['created_at'] as string),
    })),
    invited: invited.map((r) => ({
      id: r['id'] as string,
      email: r['email'] as string,
      role: r['role'] as string,
      invitedAt: new Date(r['created_at'] as string),
    })),
  }
}

/**
 * Inviting somebody, or changing your mind about the role you invited them at.
 *
 * Scoped: the insert is refused by the policy unless the caller belongs to the
 * operator they name. The operator id is still passed explicitly, because the
 * policy is the second line and an explicit scope is the first.
 */
export async function inviteMember(
  run: QueryRunner,
  input: { operatorId: string; email: string; role: string; invitedByMembershipId: string },
): Promise<{ invitationId: string | null }> {
  const rows = await run(
    `insert into operator_invitations (operator_id, email, role, invited_by_membership_id)
     values ($1, $2, $3::membership_role, $4)
     on conflict (operator_id, email) where accepted_at is null and revoked_at is null
     do update set role = excluded.role, invited_by_membership_id = excluded.invited_by_membership_id
     returning id`,
    [input.operatorId, normaliseEmail(input.email), input.role, input.invitedByMembershipId],
  )
  return { invitationId: (rows[0]?.['id'] as string) ?? null }
}

export async function revokeInvitation(
  run: QueryRunner,
  input: { operatorId: string; invitationId: string },
): Promise<{ revoked: boolean }> {
  const rows = await run(
    `update operator_invitations set revoked_at = now()
     where id = $1 and operator_id = $2 and accepted_at is null and revoked_at is null
     returning id`,
    [input.invitationId, input.operatorId],
  )
  return { revoked: rows.length > 0 }
}

/**
 * The last administrator cannot be demoted or switched off.
 *
 * Both changes go through this one statement so the check cannot be true for
 * one path and forgotten on the other. An operator with no administrator is a
 * company nobody can configure, add staff to, or recover — and the person most
 * likely to do it is the only administrator, tidying up.
 */
const LAST_ADMIN_GUARD = `
  and (
    m.role <> 'admin'
    or $4::text = 'admin'
    or exists (
      select 1 from memberships other
      where other.operator_id = m.operator_id
        and other.id <> m.id
        and other.active
        and other.role = 'admin'
    )
  )
`

export async function setMemberRole(
  run: QueryRunner,
  input: { operatorId: string; membershipId: string; role: string },
): Promise<{ changed: boolean }> {
  const rows = await run(
    `update memberships m set role = $3::membership_role
     where m.id = $1 and m.operator_id = $2 ${LAST_ADMIN_GUARD}
     returning m.id`,
    [input.membershipId, input.operatorId, input.role, input.role],
  )
  return { changed: rows.length > 0 }
}

export async function setMemberActive(
  run: QueryRunner,
  input: { operatorId: string; membershipId: string; active: boolean },
): Promise<{ changed: boolean }> {
  const rows = await run(
    // Reactivating is never the dangerous direction, so the guard only has to
    // hold when somebody is being switched off.
    `update memberships m set active = $3
     where m.id = $1 and m.operator_id = $2
       and ($3::boolean or true) ${input.active ? '' : LAST_ADMIN_GUARD}
     returning m.id`,
    input.active
      ? [input.membershipId, input.operatorId, input.active]
      : [input.membershipId, input.operatorId, input.active, 'salesperson'],
  )
  return { changed: rows.length > 0 }
}

/**
 * The name a customer sees on this person's messages.
 *
 * A first name is the right shape and the page says so, because "— Ahmed"
 * reads as a colleague and "— Ahmed Al-Mansouri, Senior Sales Executive"
 * reads as a signature block on an email. Not unique and not verified: it is
 * how somebody introduces themselves, which is all a customer needs.
 */
export async function setDisplayName(
  run: QueryRunner,
  input: { operatorId: string; membershipId: string; displayName: string },
): Promise<{ changed: boolean }> {
  const name = input.displayName.trim()
  const rows = await run(
    `update memberships set display_name = $3
     where id = $1 and operator_id = $2
     returning id`,
    [input.membershipId, input.operatorId, name === '' ? null : name],
  )
  return { changed: rows.length > 0 }
}

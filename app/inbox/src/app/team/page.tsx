import { MEMBERSHIP_ROLES } from '@vyra/contracts'
import { getNavCounts, listTeam } from '@vyra/db'
import { SiteNav } from '../site-nav'
import { InviteForm } from './invite-form'
import { changeRole, nameMember, setActive, withdrawInvitation } from './actions'
import { permissions, requireActor } from '@/lib/auth'
import { actorReads } from '@/lib/db'

export const dynamic = 'force-dynamic'

/**
 * Build plan step 36 — adding a colleague without going into the database.
 *
 * Roles are named by what they permit rather than by seniority, because that is
 * how the checks read at their call sites and a list of ranks would invite
 * somebody to assume the order means something it does not.
 */
const ROLE_DOES: Record<string, string> = {
  admin: 'Everything, including this page and the operator settings.',
  manager: 'Reply, take over, reassign, and pause the agent.',
  salesperson: 'Reply, take over and accept handoffs.',
  operations: 'Answer operations questions. Cannot reply to customers.',
}

function when(date: Date): string {
  const days = Math.floor((Date.now() - date.getTime()) / 86_400_000)
  if (days < 1) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 30) return `${days} days ago`
  return date.toISOString().slice(0, 10)
}

export default async function TeamPage() {
  const actor = await requireActor()
  const [counts, team] = await actorReads(actor, (run) => Promise.all([
    getNavCounts(run, actor.operatorId),
    listTeam(run, actor.operatorId),
  ]))

  const canAdminister = permissions.canAdminister(actor)
  const admins = team.members.filter((m) => m.active && m.role === 'admin').length

  /**
   * Who cannot reply yet, which is everybody until somebody writes a name.
   *
   * Counted over people whose role sends at all — an operations account never
   * replies to a customer, so a missing name is not stopping them from doing
   * anything.
   */
  const REPLIES = new Set(['admin', 'manager', 'salesperson'])
  const unnamed = team.members.filter(
    (m) => m.active && REPLIES.has(m.role) && m.displayName === null,
  )

  return (
    <main className="shell">
      <SiteNav current="team" counts={counts} />
      <h1>{actor.operatorName}</h1>
      <p className="muted">
        Who can see your customers, and what each of them may do. Signing in proves who somebody
        is; being on this list is what gives them access to this company.
      </p>

      {unnamed.length > 0 && (
        <p className="card" style={{ borderLeft: '3px solid var(--accent)' }}>
          {unnamed.length === 1 && unnamed[0]!.membershipId === actor.membershipId
            ? 'You have no name on file, so you cannot reply to a customer yet. '
            : `${unnamed.length} of your people have no name on file, so they cannot reply to a customer yet. `}
          Every message a person sends is signed with it, which is the only way somebody on
          WhatsApp can tell a colleague from the assistant. Nothing is guessed from an email
          address — a customer reading &ldquo;&mdash; usama1221999&rdquo; is worse served than one
          reading nothing at all.
        </p>
      )}

      {canAdminister && <InviteForm />}

      <section>
        <h2 style={{ fontSize: '1.05rem' }}>People</h2>
        <ul style={{ listStyle: 'none', padding: 0, margin: '0.8rem 0 0', display: 'grid', gap: '0.5rem' }}>
          {team.members.map((member) => (
            <li key={member.membershipId} className="card">
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem', flexWrap: 'wrap' }}>
                <div>
                  <strong>{member.displayName ?? member.email ?? member.userId.slice(0, 8)}</strong>
                  {member.displayName !== null && member.email !== null && (
                    <span className="muted" style={{ fontSize: '0.8rem' }}> · {member.email}</span>
                  )}
                  {member.membershipId === actor.membershipId && (
                    <span className="muted" style={{ fontSize: '0.8rem' }}> · you</span>
                  )}
                  {!member.active && (
                    <span className="muted" style={{ fontSize: '0.8rem' }}> · no longer has access</span>
                  )}
                  <div className="muted" style={{ fontSize: '0.8rem' }}>
                    {ROLE_DOES[member.role] ?? member.role} · joined {when(member.joinedAt)}
                  </div>
                </div>

                {canAdminister && (
                  <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'start', flexWrap: 'wrap' }}>
                    <form action={changeRole} style={{ display: 'flex', gap: '0.3rem' }}>
                      <input type="hidden" name="membershipId" value={member.membershipId} />
                      <select className="input" name="role" defaultValue={member.role} style={{ width: 'auto' }}>
                        {MEMBERSHIP_ROLES.map((role) => <option key={role} value={role}>{role}</option>)}
                      </select>
                      <button className="button secondary" type="submit">Change</button>
                    </form>
                    <form action={setActive}>
                      <input type="hidden" name="membershipId" value={member.membershipId} />
                      <input type="hidden" name="active" value={member.active ? 'false' : 'true'} />
                      <button className="button secondary" type="submit">
                        {member.active ? 'Remove access' : 'Restore access'}
                      </button>
                    </form>
                  </div>
                )}
              </div>

              {(canAdminister || member.membershipId === actor.membershipId) && member.active
                && REPLIES.has(member.role) && (
                <form
                  action={nameMember}
                  style={{ display: 'flex', gap: '0.4rem', marginTop: '0.7rem', flexWrap: 'wrap' }}
                >
                  <input type="hidden" name="membershipId" value={member.membershipId} />
                  <input
                    className="input"
                    name="displayName"
                    defaultValue={member.displayName ?? ''}
                    placeholder="First name, as a customer would say it"
                    maxLength={40}
                    style={{ flex: '1 1 12rem' }}
                  />
                  <button className="button secondary" type="submit">
                    {member.displayName === null ? 'Set name' : 'Change name'}
                  </button>
                </form>
              )}
            </li>
          ))}
        </ul>

        {admins === 1 && canAdminister && (
          <p className="muted" style={{ fontSize: '0.8rem', marginTop: '0.8rem' }}>
            You are the only administrator, so you cannot change your own role or remove your own
            access — an operator with no administrator is a company nobody can configure or
            recover. Make somebody else an administrator first.
          </p>
        )}
      </section>

      {team.invited.length > 0 && (
        <section>
          <h2 style={{ fontSize: '1.05rem' }}>Invited, not joined yet</h2>
          <p className="muted" style={{ fontSize: '0.85rem' }}>
            They join by signing up at <strong>/signup</strong> with this exact address. Send them
            the link — no email goes out from here.
          </p>
          <ul style={{ listStyle: 'none', padding: 0, margin: '0.8rem 0 0', display: 'grid', gap: '0.4rem' }}>
            {team.invited.map((invitation) => (
              <li
                key={invitation.id}
                className="card"
                style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem', flexWrap: 'wrap' }}
              >
                <span>
                  {invitation.email}
                  <span className="muted" style={{ fontSize: '0.8rem' }}>
                    {' '}· {invitation.role} · invited {when(invitation.invitedAt)}
                  </span>
                </span>
                {canAdminister && (
                  <form action={withdrawInvitation}>
                    <input type="hidden" name="invitationId" value={invitation.id} />
                    <button className="button secondary" type="submit">Withdraw</button>
                  </form>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {!canAdminister && (
        <p className="muted" style={{ fontSize: '0.85rem' }}>
          Only an administrator can invite colleagues or change what someone may do.
        </p>
      )}
    </main>
  )
}

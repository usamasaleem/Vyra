import { findPendingInvitation } from '@vyra/db'
import { createSupabaseServerClient } from '@/lib/supabase/server'
import { queryRunner } from '@/lib/db'
import { signOut } from '../login/actions'
import { FinishSetup } from './finish-setup'

export const dynamic = 'force-dynamic'

/**
 * Signed in, a member of nothing — which is a step in setting up, not an error.
 *
 * Three people land here and they need different things. Somebody whose
 * Supabase project made them confirm their address: their account exists and
 * their company does not, because creating one needed a signed-in user and
 * there was not one yet. Somebody invited after they already had an account.
 * And somebody who genuinely has no business here.
 *
 * The first two can finish from this page. The third is told plainly, which is
 * what this page did for all three before.
 */
export default async function NoAccessPage() {
  const supabase = await createSupabaseServerClient()
  const { data } = await supabase.auth.getUser()
  const email = data.user?.email ?? null

  /**
   * Privileged, and the same exception the sign-up action makes: there is no
   * membership yet, so no policy could find this person's invitation for them.
   * Keyed on the address they authenticated with.
   */
  const invitation = email === null
    ? null
    : await findPendingInvitation(queryRunner(), email)

  return (
    <main className="shell" style={{ maxWidth: '30rem', paddingTop: '4rem' }}>
      <h1 style={{ fontSize: '1.2rem' }}>One more step</h1>

      <div className="card stack">
        <p style={{ marginTop: 0 }}>
          You are signed in as <strong>{email ?? 'an unknown account'}</strong>, and this account is
          not yet part of a rental operator.
        </p>

        {invitation === null ? (
          <p className="muted" style={{ fontSize: '0.9rem' }}>
            Signing in proves who you are. Seeing a customer conversation needs this account to be
            part of a specific operator — those are separate on purpose. Set your own company up
            below, or ask a colleague to invite this address.
          </p>
        ) : (
          <p className="muted" style={{ fontSize: '0.9rem' }}>
            <strong>{invitation.operatorName}</strong> has invited you as a {invitation.role}.
          </p>
        )}

        <FinishSetup invitation={invitation} />

        <form action={signOut}>
          <button className="button secondary" type="submit">Sign out</button>
        </form>
      </div>
    </main>
  )
}

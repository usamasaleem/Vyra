import { createSupabaseServerClient } from '@/lib/supabase/server'
import { signOut } from '../login/actions'

export const dynamic = 'force-dynamic'

/**
 * Signed in, but a member of nothing.
 *
 * Not an error and not a dead end to hide: an account exists the moment
 * somebody is created in Supabase, and it must grant no access to any
 * operator's customer data until a person deliberately adds them to one.
 */
export default async function NoAccessPage() {
  const supabase = await createSupabaseServerClient()
  const { data } = await supabase.auth.getUser()

  return (
    <main className="shell" style={{ maxWidth: '30rem', paddingTop: '5rem' }}>
      <h1 style={{ fontSize: '1.2rem' }}>No access yet</h1>
      <div className="card stack">
        <p style={{ marginTop: 0 }}>
          You are signed in as <strong>{data.user?.email ?? 'an unknown account'}</strong>, but this
          account has not been added to a rental operator.
        </p>
        <p className="muted" style={{ fontSize: '0.9rem' }}>
          Signing in proves who you are. Seeing a customer conversation needs someone to grant this
          account access to a specific operator — those are separate on purpose.
        </p>
        <form action={signOut}>
          <button className="button secondary" type="submit">Sign out</button>
        </form>
      </div>
    </main>
  )
}

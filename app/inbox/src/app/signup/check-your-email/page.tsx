import Link from 'next/link'

/**
 * Where sign-up lands when the Supabase project requires a confirmed address.
 *
 * The account exists and the company does not: creating one needs a signed-in
 * user, and there isn't one until they follow the link. Saying so plainly is
 * better than a spinner, and better than creating a company for an address
 * nobody has proved they can read.
 */
export default function CheckYourEmailPage() {
  return (
    <main className="shell" style={{ maxWidth: '24rem', paddingTop: '4rem' }}>
      <h1 style={{ fontSize: '1.2rem', marginBottom: '0.25rem' }}>Check your email</h1>
      <p className="muted" style={{ marginTop: 0 }}>
        We have sent you a link to confirm your address. Open it, then sign in — your company is
        set up on the way through.
      </p>
      <p className="muted" style={{ fontSize: '0.8rem', marginTop: '1.25rem' }}>
        <Link href="/login">Back to sign in</Link>
      </p>
    </main>
  )
}

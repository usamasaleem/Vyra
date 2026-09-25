/**
 * Where Stripe sends a customer after paying. They have no account here and
 * need nothing from this page but to know it worked and where to go next.
 */
export default function PaidPage() {
  return (
    <main className="shell" style={{ maxWidth: '30rem', textAlign: 'center', paddingTop: '4rem' }}>
      <h1>Payment received</h1>
      <p>Thank you. You will get a confirmation on WhatsApp in a moment — you can close this page and go back to the chat.</p>
    </main>
  )
}

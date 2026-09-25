import { getNavCounts, paymentAccountStatus } from '@vyra/db'
import { SiteNav } from '../../site-nav'
import { ConnectStripeForm } from './connect-form'
import { disconnectStripe } from './actions'
import { permissions, requireActor } from '@/lib/auth'
import { actorReads } from '@/lib/db'

export const dynamic = 'force-dynamic'

/**
 * Where an operator connects Stripe, so the agent sends payment links itself
 * and payments are confirmed the moment they arrive.
 */
export default async function PaymentsPage() {
  const actor = await requireActor()
  const [counts, status] = await actorReads(actor, (run) => Promise.all([
    getNavCounts(run, actor.operatorId),
    paymentAccountStatus(run, actor.operatorId),
  ]))
  const canEdit = permissions.canAdminister(actor)

  return (
    <main className="shell">
      <SiteNav current="settings" counts={counts} />
      <h1>Payments</h1>
      <p className="muted">
        With Stripe connected, when a customer chooses to pay by link the agent sends them a secure Stripe
        checkout for what they owe — the rental and any extras; the deposit is still taken at the handover —
        and the booking is marked paid the moment the payment comes through. Nobody attaches a link or ticks a box.
      </p>

      <section className="card" style={{ margin: '1rem 0' }}>
        {status.connected ? (
          <>
            <p style={{ marginTop: 0 }}>
              Stripe is <strong>connected</strong> — account {status.accountId},{' '}
              {status.livemode ? <strong>live: real payments</strong> : <strong>test mode: no real money</strong>}, key ending {status.hint}.
            </p>
            {canEdit && (
              <form action={disconnectStripe} style={{ marginBottom: '1rem' }}>
                <button className="button secondary" type="submit">Disconnect Stripe</button>
              </form>
            )}
          </>
        ) : (
          <p style={{ marginTop: 0 }}>Stripe is <strong>not connected</strong>. Payment links are attached by a person on Bookings.</p>
        )}
        {canEdit ? <ConnectStripeForm connected={status.connected} /> : <p className="muted">Only an administrator can connect Stripe.</p>}
      </section>
    </main>
  )
}

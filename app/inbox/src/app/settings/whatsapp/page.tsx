import { getNavCounts, listConnectedNumbers } from '@vyra/db'
import Link from 'next/link'
import { SiteNav } from '../../site-nav'
import { ConnectForm } from './connect-form'
import { disconnectNumber } from './actions'
import { permissions, requireActor } from '@/lib/auth'
import { actorReads } from '@/lib/db'

export const dynamic = 'force-dynamic'

/**
 * The last thing standing between this and a second customer.
 *
 * An operator could already sign up, add their team, enter cars and rates and
 * answers — and then send nothing, because the worker had one access token in
 * its environment and Meta issues one per business. This is where an operator's
 * own credentials come from.
 */
export default async function WhatsAppSettingsPage() {
  const actor = await requireActor()
  const [counts, numbers] = await actorReads(actor, (run) => Promise.all([
    getNavCounts(run, actor.operatorId),
    listConnectedNumbers(run, actor.operatorId),
  ]))

  const canAdminister = permissions.canAdminister(actor)

  return (
    <main className="shell">
      <SiteNav current="settings" counts={counts} />
      <h1>WhatsApp number</h1>
      <p className="muted">
        The number your customers message. Everything the agent sends goes out as this number, so
        it needs credentials of your own — <Link href="/settings">the other settings</Link> are
        about behaviour, this one is about identity.
      </p>

      {numbers.length > 0 && (
        <section>
          <h2 style={{ fontSize: '1.05rem' }}>Connected</h2>
          <ul style={{ listStyle: 'none', padding: 0, margin: '0.8rem 0 1.2rem', display: 'grid', gap: '0.5rem' }}>
            {numbers.map((number) => (
              <li key={number.id} className="card" style={{ opacity: number.active ? 1 : 0.6 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem', flexWrap: 'wrap' }}>
                  <div>
                    <strong>{number.displayPhoneNumber ?? number.phoneNumberId}</strong>
                    {!number.active && (
                      <span className="muted" style={{ fontSize: '0.8rem' }}> · disconnected</span>
                    )}
                    <div className="muted" style={{ fontSize: '0.78rem' }}>
                      Number id {number.phoneNumberId} · business {number.wabaId}
                    </div>
                    <div className="muted" style={{ fontSize: '0.78rem' }}>
                      {number.tokenHint === null
                        ? 'No token of its own — sending with this deployment’s.'
                        : `Token ending ${number.tokenHint}.`}
                    </div>
                  </div>
                  {canAdminister && number.active && (
                    <form action={disconnectNumber}>
                      <input type="hidden" name="accountId" value={number.id} />
                      <button className="button secondary" type="submit">Disconnect</button>
                    </form>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {canAdminister ? (
        <ConnectForm hasNumber={numbers.some((n) => n.active)} />
      ) : (
        <p className="muted">Only an administrator can connect a number.</p>
      )}

      <section>
        <h2 style={{ fontSize: '1.05rem' }}>Where these come from</h2>
        <ol className="muted" style={{ fontSize: '0.85rem', paddingLeft: '1.1rem' }}>
          <li>In Meta Business Manager, open WhatsApp Manager and pick your number.</li>
          <li>
            The <strong>phone number id</strong> and the <strong>business account id</strong> are
            shown beside it. Both are long strings of digits, and neither is the phone number
            itself.
          </li>
          <li>
            Create a system user with the <code>whatsapp_business_messaging</code> permission and
            generate a token for it. A permanent one — a temporary token stops working in a day and
            takes your replies with it.
          </li>
          <li>
            Point the webhook at <code>/api/webhooks/whatsapp</code> on this site. Without it, the
            agent can send and will never hear anything.
          </li>
        </ol>
        <p className="muted" style={{ fontSize: '0.8rem' }}>
          Meta&rsquo;s embedded signup would do all of this in one dialog and needs Tech Provider
          status, which needs business verification. Until that is done, this is the way.
        </p>
      </section>
    </main>
  )
}

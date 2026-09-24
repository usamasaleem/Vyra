import { alertDevicesFor, getNavCounts, pushPublicKey, recentTeamAlerts } from '@vyra/db'
import { SiteNav } from '../site-nav'
import { AlertsSwitch } from './alerts-switch'
import { requireActor } from '@/lib/auth'
import { actorReads } from '@/lib/db'

export const dynamic = 'force-dynamic'

function when(date: Date): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Dubai', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  }).format(date)
}

function deviceName(userAgent: string | null): string {
  if (userAgent === null) return 'A device'
  if (/iPhone/.test(userAgent)) return 'iPhone'
  if (/iPad/.test(userAgent)) return 'iPad'
  if (/Android/.test(userAgent)) return 'Android phone'
  if (/Macintosh/.test(userAgent)) return 'Mac'
  if (/Windows/.test(userAgent)) return 'Windows computer'
  return 'A device'
}

/**
 * Where a person turns on alerts for their phone, and sees what was sent.
 *
 * Every person who answers customers is told when one is waiting on the team:
 * a handoff, a booking waiting for a yes, an answer the agent promised from
 * the team — and again if nobody has picked it up in time.
 */
export default async function AlertsPage() {
  const actor = await requireActor()
  const [counts, publicKey, devices, recent] = await actorReads(actor, (run) => Promise.all([
    getNavCounts(run, actor.operatorId),
    pushPublicKey(run),
    alertDevicesFor(run, { operatorId: actor.operatorId, membershipId: actor.membershipId }),
    recentTeamAlerts(run, { operatorId: actor.operatorId }),
  ]))

  return (
    <main className="shell">
      <SiteNav current="alerts" counts={counts} />
      <h1>Alerts</h1>
      <p className="muted">
        Your phone is told the moment a customer is waiting on the team: somebody needs a person,
        a booking is waiting for your yes, or the agent promised an answer from you. If nobody picks
        it up in time, everybody is told again.
        {actor.role === 'operations' && ' Operations accounts only receive their own test alerts.'}
      </p>

      <AlertsSwitch publicKey={publicKey} />

      <section style={{ marginTop: '2rem' }}>
        <h2 style={{ fontSize: '1.05rem' }}>Your devices</h2>
        {devices.length === 0 ? (
          <p className="muted">None yet. Turn alerts on above, on each phone or computer you use.</p>
        ) : (
          <ul style={{ paddingLeft: '1.1rem' }}>
            {devices.map((d) => (
              <li key={d.endpoint}>
                {deviceName(d.userAgent)} — added {when(d.createdAt)}
                {d.lastSentAt !== null && <span className="muted"> · last alert {when(d.lastSentAt)}</span>}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section style={{ marginTop: '2rem' }}>
        <h2 style={{ fontSize: '1.05rem' }}>Sent lately</h2>
        {recent.length === 0 ? (
          <p className="muted">Nothing yet.</p>
        ) : (
          <ul style={{ listStyle: 'none', padding: 0, display: 'grid', gap: '0.5rem' }}>
            {recent.map((a, i) => (
              <li key={i} className="card" style={{ padding: '0.7rem 0.9rem' }}>
                <a href={a.url}><strong>{a.title}</strong></a>
                <div>{a.body}</div>
                <div className="muted" style={{ fontSize: '0.85rem' }}>
                  {a.sentAt === null ? 'Sending…'
                    : a.delivered === 0 ? `${when(a.sentAt)} · reached no device — nobody has alerts on`
                    : `${when(a.sentAt)} · reached ${a.delivered} device${a.delivered === 1 ? '' : 's'}`}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  )
}

import { getNavCounts, getOperatorSettings, listTeam } from '@vyra/db'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { SiteNav } from '../site-nav'
import { SettingsForm } from './settings-form'
import { permissions, requireActor } from '@/lib/auth'
import { actorReads } from '@/lib/db'

export const dynamic = 'force-dynamic'

/**
 * What the operator decides about their own agent.
 *
 * Every field here was a column somebody had to change with SQL, and two of
 * them cost something real while they were out of reach: the fallback owner,
 * whose absence the worker logs on every escalation, and the follow-up gap,
 * which sat at four hours because four hours was the default rather than
 * because anybody chose it.
 */
export default async function SettingsPage() {
  const actor = await requireActor()
  const [counts, settings, team] = await actorReads(actor, (run) => Promise.all([
    getNavCounts(run, actor.operatorId),
    getOperatorSettings(run, actor.operatorId),
    listTeam(run, actor.operatorId),
  ]))

  if (settings === null) notFound()

  const canAdminister = permissions.canAdminister(actor)
  const owners = team.members.filter((m) => m.active)

  return (
    <main className="shell">
      <SiteNav current="settings" counts={counts} />
      <h1>Settings</h1>
      <p className="muted">
        How this agent behaves for {settings.name}. Everything here takes effect on the next
        message — nothing needs a restart.
      </p>

      <section className="card" style={{ marginBottom: '1rem' }}>
        <h2 style={{ fontSize: '1.05rem', marginTop: 0 }}>WhatsApp number</h2>
        <p style={{ margin: '0.3rem 0' }}>
          <strong>{settings.whatsappNumber ?? 'Not connected yet'}</strong>
        </p>
        <p className="muted" style={{ fontSize: '0.8rem', margin: '0 0 0.6rem' }}>
          Everything the agent sends goes out as this number, using credentials of your own.
          Until one is connected, this operator can be configured but cannot receive or send
          anything.
        </p>
        <Link className="button secondary" href="/settings/whatsapp">
          {settings.whatsappNumber === null ? 'Connect a number' : 'Manage credentials'}
        </Link>
      </section>

      <SettingsForm
        settings={settings}
        owners={owners.map((m) => ({
          membershipId: m.membershipId,
          label: `${m.email ?? m.userId.slice(0, 8)} · ${m.role}`,
        }))}
        readOnly={!canAdminister}
      />

      {!canAdminister && (
        <p className="muted" style={{ fontSize: '0.85rem' }}>
          Only an administrator can change these.
        </p>
      )}
    </main>
  )
}

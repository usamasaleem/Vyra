import { getNavCounts, getOperatorStatus } from '@vyra/db'
import Link from 'next/link'
import { LiveRefresh } from './live-refresh'
import { SiteNav } from './site-nav'
import { signOut } from './login/actions'
import { toggleAiSending } from './actions'
import { permissions, requireActor } from '@/lib/auth'
import { actorReads } from '@/lib/db'
import { listConversations } from '@/lib/queries/conversations'

export const dynamic = 'force-dynamic'

function when(date: Date | null): string {
  if (date === null) return '—'
  const minutes = Math.round((Date.now() - date.getTime()) / 60000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)}h ago`
  return `${Math.round(minutes / 1440)}d ago`
}

export default async function InboxPage({
  searchParams,
}: {
  searchParams: Promise<{
    stage?: string; handler?: string; priority?: string; owner?: string; needs?: string
  }>
}) {
  const actor = await requireActor()
  const filters = await searchParams
  /**
   * Every read in one scoped transaction. The role only lasts as long as a
   * transaction, so the thing to avoid is opening one per statement.
   */
  const [counts, status, conversations] = await actorReads(actor, (run) => Promise.all([
    getNavCounts(run, actor.operatorId),
    getOperatorStatus(run, actor.operatorId),
    listConversations(run, actor.operatorId, {
      salesStage: filters.stage ?? null,
      handlerMode: filters.handler ?? null,
      priority: filters.priority ?? null,
      // 'mine' resolves to this actor's membership, so the link does not need
      // to carry an id that the browser could then change to someone else's.
      owner: filters.owner === 'mine' ? actor.membershipId : (filters.owner ?? null),
      needsAttention: filters.needs === 'me',
    }),
  ]))

  const aiOn = status?.aiSendingEnabled === true

  return (
    <main className="shell">
      <LiveRefresh />
      <SiteNav current="inbox" counts={counts} />
      <div className="topbar">
        <div>
          <h1>{status?.name ?? 'Inbox'}</h1>
          <span className="who">
            {actor.email} · {actor.role}
          </span>
        </div>
        <div style={{ display: 'flex', gap: '0.6rem', alignItems: 'center' }}>
          {permissions.canControlAi(actor) ? (
            <form action={toggleAiSending}>
              <input type="hidden" name="enabled" value={String(!aiOn)} />
              <button className="button secondary" type="submit">
                {aiOn ? 'Pause AI replies' : 'Resume AI replies'}
              </button>
            </form>
          ) : null}
          <form action={signOut}>
            <button className="button secondary" type="submit">Sign out</button>
          </form>
        </div>
      </div>

      <p className={aiOn ? 'muted' : 'notice'} style={{ marginTop: 0 }}>
        {aiOn
          ? 'AI replies are enabled for this operator.'
          : 'AI replies are paused. Messages are still being received and stored, and staff can reply.'}
      </p>

      <div style={{ display: 'flex', gap: '0.5rem', margin: '1.5rem 0 1rem', flexWrap: 'wrap' }}>
        <Link className="button secondary" href="/">All</Link>
        <Link className="button secondary" href="/?owner=mine">Mine</Link>
        <Link className="button secondary" href="/?owner=unassigned">Unassigned</Link>
        <Link className="button secondary" href="/?needs=me">Waiting on you</Link>
        <Link className="button secondary" href="/?handler=human">Human-owned</Link>
        <Link className="button secondary" href="/?handler=ai">AI-owned</Link>
        <Link className="button secondary" href="/?priority=urgent">Urgent</Link>
        <Link className="button secondary" href="/?stage=qualified">Qualified</Link>
      </div>

      {conversations.length === 0 ? (
        <p className="card muted">No conversations yet.</p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: '0.6rem' }}>
          {conversations.map((c) => (
            <li key={c.id}>
              <Link
                href={`/conversations/${c.id}`}
                className="card"
                style={{ display: 'block', textDecoration: 'none', color: 'inherit' }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem' }}>
                  <strong>{c.contactName ?? c.channelIdentifier}</strong>
                  <span className="muted" style={{ fontSize: '0.8rem' }}>
                    {when(c.lastCustomerMessageAt)}
                  </span>
                </div>
                <p className="muted" style={{ margin: '0.35rem 0 0.6rem', fontSize: '0.9rem' }}>
                  {c.lastMessageDirection === 'outbound' ? 'You: ' : ''}
                  {c.lastMessageBody ?? <em>no readable message</em>}
                </p>
                {/*
                  Above the tags, not among them. This is the only line on the
                  card that asks the reader to do something, and a tag beside
                  "qualified" and "unassigned" reads as another label rather
                  than a request.
                */}
                {c.nextAction !== null && (
                  <p
                    style={{
                      margin: '0 0 0.6rem',
                      fontSize: '0.85rem',
                      padding: '0.45rem 0.6rem',
                      borderLeft: '3px solid var(--accent, #b45309)',
                      background: 'color-mix(in srgb, var(--accent, #b45309) 8%, transparent)',
                      borderRadius: '0 4px 4px 0',
                    }}
                  >
                    {c.nextAction}
                  </p>
                )}
                <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
                  <span className="tag">{c.salesStage.replace(/_/g, ' ')}</span>
                  <span className="tag">{c.handlerMode === 'human' ? 'salesperson' : 'AI'}</span>
                  {c.waitingReason !== 'none' && (
                    <span className="tag">{c.waitingReason.replace(/_/g, ' ')}</span>
                  )}
                  {c.priority !== 'normal' && <span className="tag">{c.priority}</span>}
                  {c.ownerMembershipId === null && <span className="tag">unassigned</span>}
                  {c.awaitingReply && <span className="tag">awaiting reply</span>}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  )
}

import { getNavCounts, listMembers, listNotes, PRIORITIES } from '@vyra/db'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { assignTo, changePriority, handBackToAi, takeOver } from '@/app/actions'
import { LiveRefresh } from '@/app/live-refresh'
import { SiteNav } from '@/app/site-nav'
import { permissions, requireActor } from '@/lib/auth'
import { actorReads } from '@/lib/db'
import { getConversationThread } from '@/lib/queries/conversations'
import { NoteForm } from './note-form'
import { ReplyForm } from './reply-form'

export const dynamic = 'force-dynamic'

/** Delivery states a salesperson needs explained rather than shown raw. */
const STATE_LABEL: Record<string, string> = {
  pending: 'queued',
  dispatching: 'sending',
  cancelled: 'cancelled before sending',
  accepted: 'sent',
  sent: 'sent',
  delivered: 'delivered',
  read: 'read',
  failed: 'failed',
  unknown: 'delivery unconfirmed',
}

export default async function ConversationPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const actor = await requireActor()
  const { id } = await params
  /**
   * One transaction for the page, not one per statement. Four reads at four
   * round trips each is six seconds against this database; sharing the
   * transaction pays the begin, the role and the commit once.
   */
  const page = await actorReads(actor, async (run) => {
    const thread = await getConversationThread(run, actor.operatorId, id)
    if (thread === null) return null
    /**
     * Sequential rather than Promise.all, and it costs nothing: these share
     * one connection, so the driver serialises them whatever this file asks
     * for. Writing it as concurrent would only claim a parallelism that does
     * not exist.
     */
    const counts = await getNavCounts(run, actor.operatorId)
    const notes = await listNotes(run, actor.operatorId, thread.id)
    const members = permissions.canReassign(actor)
      ? await listMembers(run, actor.operatorId)
      : []
    return { thread, counts, notes, members }
  })
  if (page === null) notFound()
  const { thread, counts, notes, members } = page

  const humanOwned = thread.handlerMode === 'human'
  const canReply = permissions.canReply(actor)
  const memberLabel = (membershipId: string | null) => {
    if (membershipId === null) return 'unassigned'
    const member = members.find((m) => m.membershipId === membershipId)
    return member?.email ?? 'a colleague'
  }

  return (
    <main className="shell">
      <LiveRefresh conversationId={thread.id} />
      <SiteNav current="inbox" counts={counts} />
      <div className="topbar">
        <div>
          <h1>{thread.contactName ?? thread.channelIdentifier}</h1>
          <span className="who">
            {thread.channelIdentifier} · revision {thread.revision}
          </span>
        </div>
        <Link className="button secondary" href="/">Back to inbox</Link>
      </div>

      <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap', marginBottom: '1rem' }}>
        <span className="tag">{thread.salesStage.replace(/_/g, ' ')}</span>
        <span className="tag">{humanOwned ? 'salesperson owns replies' : 'AI owns replies'}</span>
        {thread.waitingReason !== 'none' && (
          <span className="tag">{thread.waitingReason.replace(/_/g, ' ')}</span>
        )}
        {thread.bookingStatus !== 'none' && <span className="tag">booking {thread.bookingStatus}</span>}
        <span className="tag">{thread.priority} priority</span>
        {thread.optedOutAt !== null && <span className="tag">opted out</span>}
      </div>

      {/*
        Above the Take over button, because it is usually the reason someone
        opened this conversation. Three different paths write this — a handoff,
        a failed turn, and work the agent could not finish — and none of them
        reached a screen until now: the agent told a customer "I'll confirm the
        deposit", recorded it faithfully, and nobody could see it.
      */}
      {thread.nextAction !== null && (
        <div
          className="card"
          style={{
            marginBottom: '1.5rem',
            borderLeft: '3px solid var(--accent, #b45309)',
            background: 'color-mix(in srgb, var(--accent, #b45309) 8%, transparent)',
          }}
        >
          <strong style={{ display: 'block', fontSize: '0.8rem', letterSpacing: '0.04em', opacity: 0.75 }}>
            NEEDS A PERSON
          </strong>
          <p style={{ margin: '0.35rem 0 0' }}>{thread.nextAction}</p>
        </div>
      )}

      {canReply ? (
        <form action={humanOwned ? handBackToAi : takeOver} style={{ marginBottom: '1.5rem' }}>
          <input type="hidden" name="conversationId" value={thread.id} />
          <button className="button secondary" type="submit">
            {humanOwned ? 'Hand back to AI' : 'Take over'}
          </button>
          <span className="muted" style={{ fontSize: '0.82rem', marginLeft: '0.7rem' }}>
            {humanOwned
              ? 'Returning control to the AI is an explicit action.'
              : 'Taking over cancels any AI reply that has not been sent.'}
          </span>
        </form>
      ) : null}

      <div className="card stack" style={{ marginBottom: '1.5rem' }}>
        <div style={{ display: 'flex', gap: '1.5rem', flexWrap: 'wrap', alignItems: 'flex-end' }}>
          {permissions.canReassign(actor) ? (
            <form action={assignTo}>
              <input type="hidden" name="conversationId" value={thread.id} />
              <label className="label" htmlFor="assignee">Assigned to</label>
              <div style={{ display: 'flex', gap: '0.4rem' }}>
                <select
                  className="input" id="assignee" name="assignee"
                  defaultValue={thread.ownerMembershipId ?? ''}
                  style={{ minWidth: '14rem' }}
                >
                  <option value="">Nobody</option>
                  {members.map((m) => (
                    <option key={m.membershipId} value={m.membershipId}>
                      {m.email ?? m.membershipId.slice(0, 8)} · {m.role}
                    </option>
                  ))}
                </select>
                <button className="button secondary" type="submit">Save</button>
              </div>
            </form>
          ) : (
            <div>
              <span className="label">Assigned to</span>
              <div>{memberLabel(thread.ownerMembershipId)}</div>
            </div>
          )}

          {canReply ? (
            <form action={changePriority}>
              <input type="hidden" name="conversationId" value={thread.id} />
              <label className="label" htmlFor="priority">Priority</label>
              <div style={{ display: 'flex', gap: '0.4rem' }}>
                <select className="input" id="priority" name="priority" defaultValue={thread.priority}>
                  {PRIORITIES.map((p) => (
                    <option key={p} value={p}>{p}</option>
                  ))}
                </select>
                <button className="button secondary" type="submit">Save</button>
              </div>
            </form>
          ) : null}
        </div>
      </div>

      {notes.length > 0 && (
        <section style={{ marginBottom: '1.5rem' }}>
          <h2 style={{ fontSize: '0.9rem', color: 'var(--muted)', fontWeight: 500 }}>
            Internal notes
          </h2>
          <div style={{ display: 'grid', gap: '0.5rem' }}>
            {notes.map((n) => (
              <article key={n.id} className="card" style={{ borderStyle: 'dashed' }}>
                <div className="muted" style={{ fontSize: '0.75rem', marginBottom: '0.3rem' }}>
                  {memberLabel(n.authorMembershipId)} ·{' '}
                  {n.createdAt.toISOString().replace('T', ' ').slice(0, 16)} · not sent to the customer
                </div>
                <div style={{ whiteSpace: 'pre-wrap' }}>{n.body}</div>
              </article>
            ))}
          </div>
        </section>
      )}

      <section style={{ display: 'grid', gap: '0.6rem', marginBottom: '2rem' }}>
        {thread.messages.map((m) => {
          const outbound = m.direction === 'outbound'
          const problem = m.deliveryState === 'failed' || m.deliveryState === 'unknown'
          return (
            <article
              key={m.id}
              className="card"
              style={{
                marginLeft: outbound ? '3rem' : 0,
                marginRight: outbound ? 0 : '3rem',
                borderColor: problem ? 'var(--danger)' : undefined,
              }}
            >
              <div className="muted" style={{ fontSize: '0.75rem', marginBottom: '0.35rem' }}>
                {outbound ? (m.sentByMembershipId === null ? 'AI' : 'Salesperson') : 'Customer'}
                {' · '}
                {m.createdAt.toISOString().replace('T', ' ').slice(0, 16)}
                {outbound && ` · ${STATE_LABEL[m.deliveryState] ?? m.deliveryState}`}
              </div>
              {m.body === null ? (
                <div>
                  <em className="muted">
                    {m.kind} message — not readable automatically, needs a person
                  </em>
                  {/*
                    The agent cannot listen to it. A person can, and until now
                    had no way to: the inbox named the problem and withheld the
                    one thing that solves it. Streamed through the server, since
                    Meta's own link expires in minutes and needs the operator's
                    token.
                  */}
                  {m.playable && (
                    <div style={{ marginTop: '0.5rem' }}>
                      {m.kind === 'audio' ? (
                        <audio controls preload="none" style={{ width: '100%', maxWidth: '22rem' }}>
                          <source src={`/api/media/${m.id}`} />
                        </audio>
                      ) : m.kind === 'image' ? (
                        <a href={`/api/media/${m.id}`} target="_blank" rel="noreferrer">
                          <img
                            src={`/api/media/${m.id}`}
                            alt="Sent by the customer"
                            style={{ maxWidth: '20rem', borderRadius: 6, display: 'block' }}
                          />
                        </a>
                      ) : (
                        <a className="button secondary" href={`/api/media/${m.id}`} target="_blank" rel="noreferrer">
                          Open {m.kind}
                        </a>
                      )}
                    </div>
                  )}
                </div>
              ) : (
                <div style={{ whiteSpace: 'pre-wrap' }}>{m.body}</div>
              )}
              {m.deliveryState === 'unknown' && (
                <p className="muted" style={{ fontSize: '0.78rem', marginBottom: 0 }}>
                  We never heard back from WhatsApp. This may or may not have reached the customer —
                  check before sending it again.
                </p>
              )}
              {m.deliveryState === 'cancelled' && (
                <p className="muted" style={{ fontSize: '0.78rem', marginBottom: 0 }}>
                  Not sent: {m.errorCode?.replace(/_/g, ' ')}
                </p>
              )}
            </article>
          )
        })}
      </section>

      <div className="stack">
        {canReply ? (
          <ReplyForm conversationId={thread.id} signAs={actor.displayName} />
        ) : (
          <p className="notice">Your role cannot send customer replies, but you can leave a note.</p>
        )}
        <NoteForm conversationId={thread.id} />
      </div>
    </main>
  )
}

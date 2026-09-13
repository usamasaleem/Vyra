import Link from 'next/link'
import { notFound } from 'next/navigation'
import { handBackToAi, takeOver } from '@/app/actions'
import { permissions, requireActor } from '@/lib/auth'
import { queryRunner } from '@/lib/db'
import { getConversationThread } from '@/lib/queries/conversations'
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
  const thread = await getConversationThread(queryRunner(), actor.operatorId, id)
  if (thread === null) notFound()

  const humanOwned = thread.handlerMode === 'human'
  const canReply = permissions.canReply(actor)

  return (
    <main className="shell">
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
        {thread.optedOutAt !== null && <span className="tag">opted out</span>}
      </div>

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
                <em className="muted">
                  {m.kind} message — not readable automatically, needs a person
                </em>
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

      {canReply ? (
        <ReplyForm conversationId={thread.id} />
      ) : (
        <p className="notice">Your role cannot send customer replies.</p>
      )}
    </main>
  )
}

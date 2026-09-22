'use client'

import { useActionState } from 'react'
import { recordMoney, type MoneyState } from './actions'

/**
 * Taking the money, which nothing in this product could do.
 *
 * Method is required and has no default, for the same reason a published
 * answer needs a name against it: a row reading "paid" that cannot say how is
 * a claim nobody stands behind, and the database refuses it either way.
 *
 * No provider is wired, so bank transfer and cash come first — that is how a
 * deposit actually moves in this market, and a card form nobody can use would
 * be worse than honest buttons.
 */
export function PaymentForm({
  paymentId,
  kind,
  amount,
  state,
  linkUrl,
}: {
  paymentId: string
  kind: 'rental' | 'deposit'
  amount: string
  state: string
  linkUrl: string | null
}) {
  const [result, action, pending] = useActionState<MoneyState, FormData>(
    recordMoney, { error: null },
  )

  const label = kind === 'deposit' ? 'Deposit' : 'Rental'

  if (state === 'paid') {
    return (
      <form action={action} style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
        <input type="hidden" name="paymentId" value={paymentId} />
        <input type="hidden" name="what" value="refund" />
        <span>
          <strong>{label} {amount}</strong>
          <span className="muted" style={{ fontSize: '0.8rem' }}> · taken</span>
        </span>
        {kind === 'deposit' && (
          <>
            <input className="input" name="reference" placeholder="Refund reference" style={{ width: '11rem' }} />
            <button className="button secondary" type="submit" disabled={pending}>
              {pending ? 'Recording…' : 'Give it back'}
            </button>
          </>
        )}
        {result.error !== null && <span style={{ fontSize: '0.82rem' }}>{result.error}</span>}
      </form>
    )
  }

  if (state === 'refunded') {
    return (
      <span className="muted" style={{ fontSize: '0.88rem' }}>
        {label} {amount} · taken and given back
      </span>
    )
  }

  return (
    <form action={action} className="stack" style={{ gap: '0.4rem' }}>
      <input type="hidden" name="paymentId" value={paymentId} />
      <input type="hidden" name="what" value="paid" />
      <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
        <span>
          <strong>{label} {amount}</strong>
          <span className="muted" style={{ fontSize: '0.8rem' }}> · not taken yet</span>
        </span>
        <select className="input" name="method" defaultValue="" style={{ width: 'auto' }} required>
          <option value="" disabled>How did it arrive?</option>
          <option value="bank_transfer">Bank transfer</option>
          <option value="cash">Cash</option>
          <option value="card_in_person">Card, in person</option>
          <option value="link">Paid a link</option>
        </select>
        <input className="input" name="reference" placeholder="Their reference" style={{ width: '10rem' }} />
        <button className="button secondary" type="submit" disabled={pending}>
          {pending ? 'Recording…' : 'Mark taken'}
        </button>
      </div>

      {linkUrl === null ? (
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            className="input" name="linkUrl" placeholder="Paste a payment link to send them"
            style={{ flex: '1 1 16rem' }}
          />
          <button className="button secondary" type="submit" formAction={action} name="what" value="link">
            Attach link
          </button>
        </div>
      ) : (
        <span className="muted" style={{ fontSize: '0.82rem' }}>
          Link attached: <a href={linkUrl}>{linkUrl}</a>
        </span>
      )}

      {result.error !== null && <p className="notice">{result.error}</p>}
    </form>
  )
}

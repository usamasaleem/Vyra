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
  label: extraLabel,
  amount,
  state,
  linkUrl,
  vehicle,
}: {
  paymentId: string
  kind: 'rental' | 'deposit' | 'add_on'
  /** An add-on's own name, "Chauffeur, 3 days". */
  label?: string | null
  amount: string
  state: string
  linkUrl: string | null
  /** For the message that carries the link: "for your Ferrari 488 Spider". */
  vehicle: string | null
}) {
  const [result, action, pending] = useActionState<MoneyState, FormData>(
    recordMoney, { error: null },
  )

  const label = kind === 'deposit' ? 'Deposit' : kind === 'add_on' ? (extraLabel ?? 'Extra') : 'Rental'

  if (state === 'paid') {
    return (
      <form action={action} style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
        <input type="hidden" name="paymentId" value={paymentId} />
        <span>
          <strong>{label} {amount}</strong>
          <span className="muted" style={{ fontSize: '0.8rem' }}> · taken</span>
        </span>
        {kind === 'deposit' && (
          <>
            <input className="input" name="reference" placeholder="Refund reference" style={{ width: '11rem' }} />
            <button className="button secondary" type="submit" name="what" value="refund" disabled={pending}>
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
      {/*
        * Which of the three this is comes from the button, never from a hidden
        * field. There was one reading "paid" above these, and a submit
        * button's own name and value are appended to the form data rather
        * than replacing anything — so `what` had two values, the first won,
        * and Attach link silently ran the payment branch. It asked for a
        * method, which that half of the form does not have, and the link was
        * never saved.
        */}
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
        <button className="button secondary" type="submit" name="what" value="paid" disabled={pending}>
          {pending ? 'Recording…' : 'Mark taken'}
        </button>
      </div>

      {linkUrl === null ? (
        <LinkFields
          what="link"
          pending={pending}
          placeholder="Paste a payment link to send them"
          message={`Here is the link to pay the ${label.toLowerCase()} of ${amount}${vehicle === null ? '' : ` for your ${vehicle}`}:`}
        />
      ) : (
        <span className="muted" style={{ fontSize: '0.82rem' }}>
          Link attached: <a href={linkUrl}>{linkUrl}</a>
        </span>
      )}

      {result.error !== null && <p className="notice">{result.error}</p>}
    </form>
  )
}

/**
 * Everything still owed on a booking, as the one payment it usually is.
 *
 * A customer transferring AED 10,000 sends one transfer, not a rental and a
 * deposit. Each line had its own method, reference, button and link box —
 * eight fields to record one bank credit. This is the common case; the lines
 * one by one are still there for somebody who paid them separately.
 */
export function AllOwedForm({
  bookingId,
  total,
  breakdown,
  linkUrl,
  vehicle,
}: {
  bookingId: string
  vehicle: string | null
  /** Formatted, e.g. "AED 10,000". */
  total: string
  /** "rental AED 5,000 · deposit AED 5,000" */
  breakdown: string
  /** The link on every line still due, when they all share one. */
  linkUrl: string | null
}) {
  const [result, action, pending] = useActionState<MoneyState, FormData>(
    recordMoney, { error: null },
  )

  return (
    <form action={action} className="stack" style={{ gap: '0.4rem' }}>
      <input type="hidden" name="bookingId" value={bookingId} />
      {/* What this does comes from the button pressed — see PaymentForm. */}
      <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
        <span>
          <strong>Owed {total}</strong>
          <span className="muted" style={{ fontSize: '0.8rem' }}> · {breakdown}</span>
        </span>
        <select className="input" name="method" defaultValue="" style={{ width: 'auto' }}>
          <option value="" disabled>How did it arrive?</option>
          <option value="bank_transfer">Bank transfer</option>
          <option value="cash">Cash</option>
          <option value="card_in_person">Card, in person</option>
          <option value="link">Paid a link</option>
        </select>
        <input className="input" name="reference" placeholder="Their reference" style={{ width: '10rem' }} />
        <button className="button secondary" type="submit" name="what" value="paid_all" disabled={pending}>
          {pending ? 'Recording…' : 'Mark all taken'}
        </button>
      </div>

      {linkUrl === null ? (
        <LinkFields
          what="link_all"
          pending={pending}
          placeholder={`Paste a payment link for ${total}`}
          message={`Here is the link to pay ${total}${vehicle === null ? '' : ` for your ${vehicle}`}:`}
        />
      ) : (
        <span className="muted" style={{ fontSize: '0.82rem' }}>
          Link attached: <a href={linkUrl}>{linkUrl}</a>
        </span>
      )}

      {result.error !== null && <p className="notice">{result.error}</p>}
    </form>
  )
}

/**
 * The link, and the message that takes it to the customer.
 *
 * Attaching used to only write the link down; the customer heard nothing until
 * they happened to write again. The message is drafted and theirs to change,
 * the link is added to the end if they leave it out, and clearing it attaches
 * the link without sending anything.
 */
function LinkFields({
  what,
  pending,
  placeholder,
  message,
}: {
  what: 'link' | 'link_all'
  pending: boolean
  placeholder: string
  message: string
}) {
  return (
    <div className="stack" style={{ gap: '0.4rem' }}>
      <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
        <input className="input" name="linkUrl" placeholder={placeholder} style={{ flex: '1 1 16rem' }} />
        <button className="button secondary" type="submit" name="what" value={what} disabled={pending}>
          {pending ? 'Sending…' : 'Attach and send'}
        </button>
      </div>
      <textarea
        className="input" name="message" rows={2} defaultValue={message}
        aria-label="Message sent with the link"
        style={{ fontSize: '0.88rem' }}
      />
      <span className="muted" style={{ fontSize: '0.78rem' }}>
        Sent to them signed with your name, with the link added at the end. Clear it to attach the
        link without sending anything.
      </span>
    </div>
  )
}

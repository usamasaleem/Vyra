import type { QueryRunner } from '../runner.js'

/**
 * An operator's Stripe account, and the checkouts made through it.
 *
 * What is taken by link is the rental and anything added to it. The deposit
 * is not: a card hold lasts about a week, and most cars are booked further
 * ahead than that, so the deposit stays with the handover — as the operator's
 * payment answer already tells customers.
 */

export type PaymentAccount = {
  provider: 'stripe'
  secretKeyCipher: string
  webhookSecretCipher: string
  webhookEndpointId: string
  accountId: string
  livemode: boolean
}

export async function savePaymentAccount(
  run: QueryRunner,
  input: PaymentAccount & { operatorId: string; secretKeyHint: string; membershipId: string },
): Promise<void> {
  await run(
    `insert into payment_accounts (operator_id, provider, secret_key_cipher, secret_key_hint, webhook_secret_cipher,
                                   webhook_endpoint_id, account_id, livemode, connected_by_membership_id, connected_at)
     values ($1, 'stripe', $2, $3, $4, $5, $6, $7, $8, now())
     on conflict (operator_id) do update set
       secret_key_cipher = excluded.secret_key_cipher, secret_key_hint = excluded.secret_key_hint,
       webhook_secret_cipher = excluded.webhook_secret_cipher, webhook_endpoint_id = excluded.webhook_endpoint_id,
       account_id = excluded.account_id, livemode = excluded.livemode,
       connected_by_membership_id = excluded.connected_by_membership_id, connected_at = now()`,
    [input.operatorId, input.secretKeyCipher, input.secretKeyHint, input.webhookSecretCipher,
      input.webhookEndpointId, input.accountId, input.livemode, input.membershipId],
  )
}

export async function paymentAccountFor(run: QueryRunner, operatorId: string): Promise<PaymentAccount | null> {
  const [row] = await run(
    `select secret_key_cipher, webhook_secret_cipher, webhook_endpoint_id, account_id, livemode
     from payment_accounts where operator_id = $1 and provider = 'stripe'`,
    [operatorId],
  )
  if (row === undefined) return null
  return {
    provider: 'stripe',
    secretKeyCipher: row['secret_key_cipher'] as string,
    webhookSecretCipher: row['webhook_secret_cipher'] as string,
    webhookEndpointId: row['webhook_endpoint_id'] as string,
    accountId: row['account_id'] as string,
    livemode: row['livemode'] === true,
  }
}

export type PaymentAccountStatus = {
  connected: boolean
  accountId: string | null
  livemode: boolean
  hint: string | null
  connectedAt: Date | null
}

export async function paymentAccountStatus(run: QueryRunner, operatorId: string): Promise<PaymentAccountStatus> {
  const [row] = await run(
    `select account_id, livemode, secret_key_hint, connected_at from payment_accounts where operator_id = $1`,
    [operatorId],
  )
  return {
    connected: row !== undefined,
    accountId: (row?.['account_id'] as string) ?? null,
    livemode: row?.['livemode'] === true,
    hint: (row?.['secret_key_hint'] as string) ?? null,
    connectedAt: row?.['connected_at'] == null ? null : new Date(row['connected_at'] as string),
  }
}

export async function removePaymentAccount(run: QueryRunner, operatorId: string): Promise<void> {
  await run(`delete from payment_accounts where operator_id = $1`, [operatorId])
}

export type LinkNeeded = {
  bookingId: string
  conversationId: string
  paymentIds: string[]
  amountMinor: number
  currency: string
  description: string
  /** A checkout already made and still open: sent again rather than replaced. */
  openLink: string | null
}

/**
 * What a payment link should cover for one booking: everything still owed
 * except the deposit. Null when nothing is owed that a link can take.
 */
export async function linkNeeded(
  run: QueryRunner,
  input: { operatorId: string; bookingId: string },
): Promise<LinkNeeded | null> {
  const rows = await run(
    `select p.id, p.amount_minor, p.currency, p.link_url, p.link_expires_at, p.conversation_id,
            trim(v.make || ' ' || v.model || ' ' || coalesce(v.variant, '')) as vehicle,
            q.start_date::date::text as start_date, coalesce(q.end_date, q.start_date)::date::text as end_date
     from payments p
     join bookings b on b.id = p.booking_id and b.operator_id = p.operator_id
     join quotes q on q.id = b.quote_id and q.operator_id = b.operator_id
     left join vehicles v on v.id = q.vehicle_id
     where p.booking_id = $1 and p.operator_id = $2 and p.state = 'due' and p.kind <> 'deposit'
       and b.state = 'confirmed'
     order by p.created_at`,
    [input.bookingId, input.operatorId],
  )
  if (rows.length === 0) return null
  const first = rows[0]!
  const open = rows.every((r) => r['link_url'] != null && r['link_url'] === first['link_url']
    && r['link_expires_at'] != null && new Date(r['link_expires_at'] as string).getTime() > Date.now() + 60 * 60 * 1000)
  return {
    bookingId: input.bookingId,
    conversationId: first['conversation_id'] as string,
    paymentIds: rows.map((r) => r['id'] as string),
    amountMinor: rows.reduce((sum, r) => sum + Number(r['amount_minor']), 0),
    currency: first['currency'] as string,
    description: `${(first['vehicle'] as string) ?? 'Car rental'}, ${first['start_date'] as string} to ${first['end_date'] as string}`,
    openLink: open ? (first['link_url'] as string) : null,
  }
}

export async function attachCheckout(
  run: QueryRunner,
  input: { operatorId: string; paymentIds: string[]; url: string; sessionId: string; expiresAt: Date },
): Promise<void> {
  await run(
    `update payments set link_url = $3, link_session_id = $4, link_expires_at = $5, updated_at = now()
     where operator_id = $1 and id = any($2::uuid[]) and state = 'due'`,
    [input.operatorId, input.paymentIds, input.url, input.sessionId, input.expiresAt.toISOString()],
  )
}

/** Stripe says the checkout was paid: every line it covered is paid, by link. */
export async function markCheckoutPaid(
  run: QueryRunner,
  input: { operatorId: string; sessionId: string; reference: string | null },
): Promise<{ bookingId: string; conversationId: string; paidMinor: number; currency: string } | null> {
  const rows = await run(
    `update payments set state = 'paid', method = 'link', paid_at = now(),
                         reference = coalesce($3, reference), updated_at = now()
     where operator_id = $1 and link_session_id = $2 and state = 'due'
     returning booking_id, conversation_id, amount_minor, currency`,
    [input.operatorId, input.sessionId, input.reference],
  )
  if (rows.length === 0) return null
  await run(
    `insert into audit_events (operator_id, actor_type, action, subject_type, subject_id, data)
     values ($1, 'system', 'payment.paid_by_link', 'booking', $2, $3::jsonb)`,
    [input.operatorId, rows[0]!['booking_id'], JSON.stringify({ session: input.sessionId, reference: input.reference })],
  )
  return {
    bookingId: rows[0]!['booking_id'] as string,
    conversationId: rows[0]!['conversation_id'] as string,
    paidMinor: rows.reduce((sum, r) => sum + Number(r['amount_minor']), 0),
    currency: rows[0]!['currency'] as string,
  }
}

/** The checkout ran out unpaid: forget it, so the next ask makes a fresh one. */
export async function forgetCheckout(run: QueryRunner, input: { operatorId: string; sessionId: string }): Promise<void> {
  await run(
    `update payments set link_url = null, link_session_id = null, link_expires_at = null, updated_at = now()
     where operator_id = $1 and link_session_id = $2 and state = 'due'`,
    [input.operatorId, input.sessionId],
  )
}

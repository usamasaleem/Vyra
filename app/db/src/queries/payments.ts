import type { QueryRunner, Transactor } from '../runner.js'

/**
 * What the customer owes, and whether it has arrived.
 *
 * `bookings` had no payment state at all: a car could be confirmed, held and
 * handed over with nothing recording whether a dirham had moved. The deposit
 * was the sharper half — it flows from the rate into the quote and onto the
 * screen, is quoted to customers, and has never been taken or given back by
 * anything in this product.
 *
 * No provider is wired and this does not pretend one is. What it records is
 * what is owed, what was taken, how, and who says so — which is what a Dubai
 * luxury rental actually runs on, where a deposit usually arrives as a bank
 * transfer and a person marks it off. When a provider is wired, it writes to
 * the same rows through `provider` and `providerRef`, and nothing else here
 * changes.
 *
 * Nothing expires. An unpaid rental the day before the car goes out is a
 * question for a person, not something to cancel automatically behind their
 * back, and which of those an operator wants is their decision rather than a
 * default I should pick for them.
 */

export type PaymentKind = 'rental' | 'deposit'
export type PaymentMethod = 'link' | 'bank_transfer' | 'cash' | 'card_in_person'

export type Owed = {
  paymentId: string
  kind: PaymentKind
  amountMinor: number
  currency: string
  state: string
  method: string | null
  linkUrl: string | null
  reference: string | null
  paidAt: Date | null
  refundedAt: Date | null
}

/**
 * Raised when a booking is confirmed, from the quote the customer agreed to.
 *
 * Never from a figure retyped here. The rental total and the deposit are both
 * on the quote already, which is the same reason the hold takes its dates from
 * there: one set of numbers, and no second one to drift from it.
 *
 * A deposit row only exists when the operator has set one on the rate. Most
 * have not, and inventing one would be the failure this whole system is built
 * to prevent.
 */
export async function raiseWhatIsOwed(
  tx: QueryRunner,
  input: {
    operatorId: string
    bookingId: string
    /**
     * Which kinds to raise. Defaults to both.
     *
     * An extension passes `['rental']`: its quote carries a deposit because
     * every quote does, and the customer already has the car and the deposit
     * held against it. Raising a second one would ask them to pay a deposit
     * twice for the same rental.
     */
    only?: readonly PaymentKind[]
  },
): Promise<{ raised: number }> {
  const kinds = input.only ?? (['rental', 'deposit'] as const)
  const rows = await tx(
    `insert into payments (operator_id, booking_id, conversation_id, kind, amount_minor, currency)
     select b.operator_id, b.id, b.conversation_id, k.kind::payment_kind, k.amount, q.currency
     from bookings b
     join quotes q on q.id = b.quote_id and q.operator_id = b.operator_id
     cross join lateral (
       values ('rental', q.total_minor), ('deposit', q.deposit_minor)
     ) as k(kind, amount)
     where b.id = $1 and b.operator_id = $2
       and k.kind = any($3::text[])
       and k.amount is not null and k.amount > 0
     on conflict do nothing
     returning id`,
    [input.bookingId, input.operatorId, kinds as unknown as string[]],
  )
  return { raised: rows.length }
}

/** Everything owed or taken against one booking, rental first. */
export async function whatIsOwed(
  run: QueryRunner,
  input: { operatorId: string; bookingId: string },
): Promise<Owed[]> {
  const rows = await run(
    `select id, kind::text as kind, state::text as state, amount_minor, currency,
            method::text as method, link_url, reference, paid_at, refunded_at
     from payments
     where operator_id = $1 and booking_id = $2 and state <> 'cancelled'
     order by case kind when 'rental' then 0 else 1 end`,
    [input.operatorId, input.bookingId],
  )
  return rows.map((r) => ({
    paymentId: r['id'] as string,
    kind: r['kind'] as PaymentKind,
    amountMinor: Number(r['amount_minor']),
    currency: r['currency'] as string,
    state: r['state'] as string,
    method: (r['method'] as string) ?? null,
    linkUrl: (r['link_url'] as string) ?? null,
    reference: (r['reference'] as string) ?? null,
    paidAt: r['paid_at'] == null ? null : new Date(r['paid_at'] as string),
    refundedAt: r['refunded_at'] == null ? null : new Date(r['refunded_at'] as string),
  }))
}

/**
 * Marking one taken, with a name and a method against it.
 *
 * The check constraint refuses a `paid` row without both, so this cannot
 * record a payment nobody can account for — the same rule the quotes and
 * knowledge tables carry, for the same reason.
 */
export async function recordPayment(
  run: QueryRunner,
  input: {
    operatorId: string
    paymentId: string
    membershipId: string
    method: PaymentMethod
    reference?: string | null
  },
): Promise<{ recorded: boolean }> {
  const rows = await run(
    `update payments
     set state = 'paid', method = $4::payment_method, paid_at = now(),
         recorded_by_membership_id = $3, reference = coalesce($5, reference),
         updated_at = now()
     where id = $1 and operator_id = $2 and state = 'due'
     returning id`,
    [input.paymentId, input.operatorId, input.membershipId, input.method, input.reference ?? null],
  )
  return { recorded: rows.length > 0 }
}

/**
 * Giving a deposit back, which is the whole point of holding one.
 *
 * Only a paid one can be refunded — the constraint says so as well — because
 * "refunded" against money that never arrived is a story, not a record.
 */
export async function refundPayment(
  run: QueryRunner,
  input: {
    operatorId: string
    paymentId: string
    membershipId: string
    reference?: string | null
  },
): Promise<{ refunded: boolean }> {
  const rows = await run(
    `update payments
     set state = 'refunded', refunded_at = now(), recorded_by_membership_id = $3,
         reference = coalesce($4, reference), updated_at = now()
     where id = $1 and operator_id = $2 and state = 'paid'
     returning id`,
    [input.paymentId, input.operatorId, input.membershipId, input.reference ?? null],
  )
  return { refunded: rows.length > 0 }
}

/** A link from whatever the operator already uses, against what it is for. */
export async function attachPaymentLink(
  run: QueryRunner,
  input: { operatorId: string; paymentId: string; linkUrl: string },
): Promise<{ attached: boolean }> {
  const rows = await run(
    `update payments set link_url = $3, updated_at = now()
     where id = $1 and operator_id = $2 and state = 'due'
     returning id`,
    [input.paymentId, input.operatorId, input.linkUrl],
  )
  return { attached: rows.length > 0 }
}

/**
 * Everything still owed on a booking, taken in one go.
 *
 * Most customers pay the rental and the deposit in one transfer, and the
 * diary gave that one transfer eight fields: a method, a reference and a
 * button for each line, and a link box under both. One statement, so a
 * salesperson either records the whole transfer or none of it.
 */
export async function recordAllDue(
  run: QueryRunner,
  input: {
    operatorId: string
    bookingId: string
    membershipId: string
    method: PaymentMethod
    reference?: string | null
  },
): Promise<{ recorded: number }> {
  const rows = await run(
    `update payments
     set state = 'paid', method = $4::payment_method, paid_at = now(),
         recorded_by_membership_id = $3, reference = coalesce($5, reference),
         updated_at = now()
     where booking_id = $1 and operator_id = $2 and state = 'due'
     returning id`,
    [input.bookingId, input.operatorId, input.membershipId, input.method, input.reference ?? null],
  )
  return { recorded: rows.length }
}

/**
 * One link for the whole amount, written against every line it covers — so
 * the agent, which reads a link off whatever is still due, sends the same one
 * whichever line it looks at.
 */
export async function attachLinkToAllDue(
  run: QueryRunner,
  input: { operatorId: string; bookingId: string; linkUrl: string },
): Promise<{ attached: number }> {
  const rows = await run(
    `update payments set link_url = $3, updated_at = now()
     where booking_id = $1 and operator_id = $2 and state = 'due'
     returning id`,
    [input.bookingId, input.operatorId, input.linkUrl],
  )
  return { attached: rows.length }
}

export type OutstandingPayment = {
  paymentId: string
  bookingId: string
  conversationId: string
  kind: PaymentKind
  amountMinor: number
  currency: string
  linkUrl: string | null
  customer: string
  customerName: string | null
  vehicle: string | null
  startDate: string | null
}

/**
 * Everything still owed, soonest rental first.
 *
 * Soonest rather than oldest, because the question this answers is "what goes
 * out before we have been paid", and a car leaving tomorrow matters more than
 * one leaving in March whoever asked first.
 */
export async function listOutstanding(
  run: QueryRunner,
  operatorId: string,
): Promise<OutstandingPayment[]> {
  const rows = await run(
    `select p.id, p.booking_id, p.conversation_id, p.kind::text as kind,
            p.amount_minor, p.currency, p.link_url,
            ct.channel_identifier, ct.display_name,
            trim(v.make || ' ' || v.model || ' ' || coalesce(v.variant, '')) as vehicle,
            q.start_date::date::text as start_date
     from payments p
     join bookings b on b.id = p.booking_id and b.operator_id = p.operator_id
     join quotes q on q.id = b.quote_id and q.operator_id = p.operator_id
     join conversations c on c.id = p.conversation_id and c.operator_id = p.operator_id
     join contacts ct on ct.id = c.contact_id
     left join vehicles v on v.id = q.vehicle_id
     where p.operator_id = $1 and p.state = 'due' and b.state = 'confirmed'
     order by q.start_date asc nulls last`,
    [operatorId],
  )
  return rows.map((r) => ({
    paymentId: r['id'] as string,
    bookingId: r['booking_id'] as string,
    conversationId: r['conversation_id'] as string,
    kind: r['kind'] as PaymentKind,
    amountMinor: Number(r['amount_minor']),
    currency: r['currency'] as string,
    linkUrl: (r['link_url'] as string) ?? null,
    customer: r['channel_identifier'] as string,
    customerName: (r['display_name'] as string) ?? null,
    vehicle: (r['vehicle'] as string) ?? null,
    startDate: (r['start_date'] as string) ?? null,
  }))
}

/** Used by the booking path, which raises these inside its own transaction. */
export type RaiseOwed = typeof raiseWhatIsOwed
export type { Transactor }

import type { QueryRunner } from '../runner.js'

/**
 * What a confirmed booking still needs before the car can leave.
 *
 * The agent used to stop at "Booked", and everything that turns a booking into
 * a car at somebody's door — where, when, the documents, the money — fell to a
 * salesperson messaging the customer again. This is the list the agent works
 * through itself instead, one thing at a time, and the list a person reads on
 * the diary to see what is left for them: checking, not chasing.
 */

export type PaymentPlan = 'transfer' | 'link' | 'on_delivery'

export type Checklist = {
  bookingId: string
  vehicle: string | null
  startDate: string | null
  deliveryWanted: boolean
  deliveryAddress: string | null
  deliveryTime: string | null
  paymentPlan: PaymentPlan | null
  customerReportedPaidAt: Date | null
  /** Photos the customer sent against this booking. */
  documents: number
  documentsCheckedAt: Date | null
  /** Anything still owed, formatted by the caller. */
  owedMinor: number
  currency: string
  /** A link a salesperson attached to something still owed, if any. */
  paymentLink: string | null
  /** What the agent should ask for next, in order; empty when it is done. */
  missing: ChecklistItem[]
}

export type ChecklistItem =
  | 'delivery_address' | 'delivery_time' | 'collection_time' | 'documents' | 'payment'

/**
 * What each item is, in the words the agent is told to ask for it.
 *
 * One list rather than one per caller: the booking tool, the progress tool and
 * the turn each kept their own copy, and a checklist item added to one would
 * have been asked for as its bare key by the others.
 */
export const ASK_FOR: Record<ChecklistItem, string> = {
  delivery_address: 'the address the car should go to',
  delivery_time: 'what time on the first day they want it delivered',
  collection_time: 'what time on the first day they will come to collect it',
  documents: 'a photo of their driving licence and of their passport or Emirates ID',
  payment: 'how they would like to pay',
}

/** Two photos: a licence, and a passport or Emirates ID. */
export const DOCUMENTS_WANTED = 2

export async function bookingChecklist(
  run: QueryRunner,
  input: { operatorId: string; bookingId: string },
): Promise<Checklist | null> {
  const [row] = await run(
    `select b.id, b.delivery_address, b.delivery_time, b.payment_plan,
            b.customer_reported_paid_at, b.documents_checked_at,
            trim(v.make || ' ' || v.model || ' ' || coalesce(v.variant, '')) as vehicle,
            q.start_date::date::text as start_date, q.currency,
            -- Delivery is only asked about when they asked for delivery. A
            -- customer collecting from the showroom has no address to give.
            coalesce((select fe.value from field_evidence fe
                      where fe.enquiry_id = b.enquiry_id and fe.field = 'delivery_preference'
                        and fe.superseded_at is null limit 1), '') as delivery_preference,
            (select count(*)::int from booking_documents d where d.booking_id = b.id) as documents,
            (select coalesce(sum(p.amount_minor), 0)::bigint from payments p
              where p.booking_id = b.id and p.state = 'due') as owed,
            (select p.link_url from payments p
              where p.booking_id = b.id and p.state = 'due' and p.link_url is not null
              order by p.created_at limit 1) as link
     from bookings b
     join quotes q on q.id = b.quote_id and q.operator_id = b.operator_id
     left join vehicles v on v.id = q.vehicle_id
     where b.id = $1 and b.operator_id = $2 and b.state = 'confirmed'`,
    [input.bookingId, input.operatorId],
  )
  if (row === undefined) return null

  const deliveryWanted = /deliver/i.test(row['delivery_preference'] as string)
  const documents = Number(row['documents'])
  const owed = Number(row['owed'])

  const missing: Checklist['missing'] = []
  if (deliveryWanted && row['delivery_address'] == null) missing.push('delivery_address')
  if (deliveryWanted && row['delivery_time'] == null) missing.push('delivery_time')
  /**
   * A customer collecting still has a time. Live: "collection it is",
   * "Confirmed", and nobody ever learned when they were coming for the car —
   * a Ferrari prepared for nobody, or nobody there when they arrive. Stored
   * in the same column: it is the handover time either way.
   */
  if (!deliveryWanted && row['delivery_time'] == null) missing.push('collection_time')
  if (documents < DOCUMENTS_WANTED && row['documents_checked_at'] == null) missing.push('documents')
  /**
   * Payment is settled from the customer's side once they have chosen a way
   * to pay and, for anything but paying on delivery, said they have done it.
   * Whether the money actually arrived is a person's to confirm on the
   * payment rows; the agent's job is only to have asked.
   */
  const plan = (row['payment_plan'] as PaymentPlan | null) ?? null
  const paymentSettledFromTheirSide = owed === 0
    || plan === 'on_delivery'
    || (plan !== null && row['customer_reported_paid_at'] != null)
  if (!paymentSettledFromTheirSide) missing.push('payment')

  return {
    bookingId: row['id'] as string,
    vehicle: (row['vehicle'] as string) ?? null,
    startDate: (row['start_date'] as string) ?? null,
    deliveryWanted,
    deliveryAddress: (row['delivery_address'] as string) ?? null,
    deliveryTime: (row['delivery_time'] as string) ?? null,
    paymentPlan: plan,
    customerReportedPaidAt: row['customer_reported_paid_at'] == null
      ? null : new Date(row['customer_reported_paid_at'] as string),
    documents,
    documentsCheckedAt: row['documents_checked_at'] == null
      ? null : new Date(row['documents_checked_at'] as string),
    owedMinor: owed,
    currency: row['currency'] as string,
    paymentLink: (row['link'] as string) ?? null,
    missing,
  }
}

/**
 * The confirmed booking this conversation is working through, soonest first.
 *
 * Soonest because that is the one whose car leaves first, and the one a
 * customer with two rentals most needs finished.
 */
export async function activeBookingFor(
  run: QueryRunner,
  input: { operatorId: string; conversationId: string },
): Promise<string | null> {
  const [row] = await run(
    `select b.id from bookings b
     join quotes q on q.id = b.quote_id and q.operator_id = b.operator_id
     where b.operator_id = $1 and b.conversation_id = $2 and b.state = 'confirmed'
       and coalesce(q.end_date, q.start_date)::date >= current_date
     order by q.start_date asc
     limit 1`,
    [input.operatorId, input.conversationId],
  )
  return (row?.['id'] as string) ?? null
}

/**
 * What the customer told the agent about delivery and payment.
 *
 * Only ever fills a gap or corrects one; passing null leaves a field alone, so
 * a turn that learns the time cannot wipe the address it learned before.
 */
export async function recordBookingProgress(
  run: QueryRunner,
  input: {
    operatorId: string
    bookingId: string
    deliveryAddress?: string | null
    deliveryTime?: string | null
    paymentPlan?: PaymentPlan | null
    saysPaid?: boolean
  },
): Promise<{ recorded: boolean }> {
  const rows = await run(
    `update bookings
     set delivery_address = coalesce($3, delivery_address),
         delivery_time = coalesce($4, delivery_time),
         payment_plan = coalesce($5, payment_plan),
         customer_reported_paid_at = case when $6 then coalesce(customer_reported_paid_at, now())
                                          else customer_reported_paid_at end,
         updated_at = now()
     where id = $1 and operator_id = $2 and state = 'confirmed'
     returning id`,
    [
      input.bookingId, input.operatorId,
      input.deliveryAddress ?? null, input.deliveryTime ?? null,
      input.paymentPlan ?? null, input.saysPaid === true,
    ],
  )
  return { recorded: rows.length > 0 }
}

/**
 * A photo the customer sent, filed against the booking it is for.
 *
 * Never read, never judged: the agent cannot see images, and whether a licence
 * is valid is a person's call. Idempotent on the message, so a retried job
 * files it once.
 */
export async function fileBookingDocument(
  run: QueryRunner,
  input: { operatorId: string; bookingId: string; conversationId: string; messageId: string },
): Promise<{ filed: boolean; total: number }> {
  await run(
    `insert into booking_documents (operator_id, booking_id, conversation_id, message_id)
     values ($1, $2, $3, $4)
     on conflict do nothing`,
    [input.operatorId, input.bookingId, input.conversationId, input.messageId],
  )
  const [row] = await run(
    `select count(*)::int as n from booking_documents where booking_id = $1 and operator_id = $2`,
    [input.bookingId, input.operatorId],
  )
  return { filed: true, total: Number(row?.['n'] ?? 0) }
}

/** A person has looked at the photos. Their name goes on it. */
export async function markDocumentsChecked(
  run: QueryRunner,
  input: { operatorId: string; bookingId: string; membershipId: string },
): Promise<{ checked: boolean }> {
  const rows = await run(
    `update bookings
     set documents_checked_at = now(), documents_checked_by_membership_id = $3, updated_at = now()
     where id = $1 and operator_id = $2 and documents_checked_at is null
     returning id`,
    [input.bookingId, input.operatorId, input.membershipId],
  )
  return { checked: rows.length > 0 }
}

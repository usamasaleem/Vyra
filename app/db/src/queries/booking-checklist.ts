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
  enquiryId: string | null
  /** What they chose, or null when nobody has asked yet. */
  handover: 'delivery' | 'collection' | null
  vehicle: string | null
  startDate: string | null
  /** The last day, inclusive — the day the car comes back. */
  endDate: string | null
  days: number | null
  totalMinor: number
  depositMinor: number | null
  deliveryWanted: boolean
  deliveryAddress: string | null
  deliveryTime: string | null
  paymentPlan: PaymentPlan | null
  customerReportedPaidAt: Date | null
  /** Photos the customer sent against this booking. */
  documents: number
  documentsCheckedAt: Date | null
  /**
   * When a person checked this customer's documents for an earlier rental,
   * within the last year. Set, the booking does not ask for them again.
   */
  documentsOnFileFrom: Date | null
  /** Anything still owed, formatted by the caller. */
  owedMinor: number
  currency: string
  /** A link a salesperson attached to something still owed, if any. */
  paymentLink: string | null
  /** Money a person has marked taken, rental and deposit together. */
  paidMinor: number
  /** Extras on the booking — a chauffeur, more kilometres — as the customer reads them. */
  addOns: Array<{ label: string; amountMinor: number }>
  returnTime: string | null
  returnAddress: string | null
  returnedAt: Date | null
  /** What the agent should ask for next, in order; empty when it is done. */
  missing: ChecklistItem[]
}

/**
 * The items that stand between a booking and the car going out. When none of
 * these is missing the booking is complete, and the customer is sent the whole
 * of it in one message.
 */
export const BEFORE_HANDOVER: readonly ChecklistItem[] = [
  'handover_choice', 'delivery_address', 'delivery_time', 'collection_time', 'documents', 'payment',
]

export type ChecklistItem =
  | 'handover_choice' | 'delivery_address' | 'delivery_time' | 'collection_time' | 'documents'
  | 'payment' | 'return_time' | 'return_address'

/**
 * What each item is, in the words the agent is told to ask for it.
 *
 * One list rather than one per caller: the booking tool, the progress tool and
 * the turn each kept their own copy, and a checklist item added to one would
 * have been asked for as its bare key by the others.
 */
export const ASK_FOR: Record<ChecklistItem, string> = {
  handover_choice: 'whether they want it delivered or will collect it themselves',
  delivery_address: 'the address the car should go to — a building or villa and the area, not a P.O. Box',
  delivery_time: 'what time on the first day they want it delivered',
  collection_time: 'what time on the first day they will come to collect it',
  documents: 'a photo of their driving licence and of their passport or Emirates ID',
  payment: 'how they would like to pay',
  return_time: 'what time on the last day the car should come back',
  return_address: 'where the car should be collected from at the end — the same address, or another',
}

/** Two photos: a licence, and a passport or Emirates ID. */
export const DOCUMENTS_WANTED = 2

export async function bookingChecklist(
  run: QueryRunner,
  input: { operatorId: string; bookingId: string },
): Promise<Checklist | null> {
  const [row] = await run(
    `select b.id, b.enquiry_id, b.delivery_address, b.delivery_time, b.payment_plan,
            b.customer_reported_paid_at, b.documents_checked_at,
            b.return_time, b.return_address, b.returned_at,
            coalesce(q.end_date, q.start_date)::date::text as end_date,
            q.days, q.total_minor, q.deposit_minor,
            -- Whether the end is near enough to arrange: the day before, in
            -- the operator's own calendar rather than the server's.
            (coalesce(q.end_date, q.start_date)::date - 1
              <= (now() at time zone o.timezone)::date) as return_is_near,
            (select coalesce(sum(p.amount_minor), 0)::bigint from payments p
              where p.booking_id = b.id and p.state = 'paid') as paid,
            (select coalesce(jsonb_agg(jsonb_build_object('label', p.label, 'amountMinor', p.amount_minor)
                                       order by p.created_at), '[]'::jsonb)
              from payments p where p.booking_id = b.id and p.kind = 'add_on'
                and p.state in ('due', 'paid')) as add_ons,
            trim(v.make || ' ' || v.model || ' ' || coalesce(v.variant, '')) as vehicle,
            q.start_date::date::text as start_date, q.currency,
            -- Delivery is only asked about when they asked for delivery. A
            -- customer collecting from the showroom has no address to give.
            coalesce((select fe.value from field_evidence fe
                      where fe.enquiry_id = b.enquiry_id and fe.field = 'delivery_preference'
                        and fe.superseded_at is null limit 1), '') as delivery_preference,
            (select count(*)::int from booking_documents d where d.booking_id = b.id) as documents,
            (select max(pb.documents_checked_at) from bookings pb
              join conversations pc on pc.id = pb.conversation_id and pc.operator_id = pb.operator_id
              join conversations bc on bc.id = b.conversation_id and bc.operator_id = b.operator_id
              where pb.operator_id = b.operator_id and pc.contact_id = bc.contact_id and pb.id <> b.id
                and pb.documents_checked_at > now() - interval '365 days') as on_file,
            (select coalesce(sum(p.amount_minor), 0)::bigint from payments p
              where p.booking_id = b.id and p.state = 'due') as owed,
            (select p.link_url from payments p
              where p.booking_id = b.id and p.state = 'due' and p.link_url is not null
              order by p.created_at limit 1) as link
     from bookings b
     join quotes q on q.id = b.quote_id and q.operator_id = b.operator_id
     join operators o on o.id = b.operator_id
     left join vehicles v on v.id = q.vehicle_id
     where b.id = $1 and b.operator_id = $2 and b.state = 'confirmed'`,
    [input.bookingId, input.operatorId],
  )
  if (row === undefined) return null

  const preference = row['delivery_preference'] as string
  const deliveryWanted = /deliver/i.test(preference)
  /**
   * Not chosen is not collection. Live: a customer who had never been asked
   * was told "What time will you collect the Ferrari on Thursday?", answered
   * 4pm, and then picked Delivery from the buttons on the next message — the
   * time they gave was for a handover that was never going to happen.
   */
  const handoverKnown = deliveryWanted || /collect|pick/i.test(preference)
  const documents = Number(row['documents'])
  const owed = Number(row['owed'])

  const missing: Checklist['missing'] = []
  if (!handoverKnown) missing.push('handover_choice')
  if (deliveryWanted && row['delivery_address'] == null) missing.push('delivery_address')
  if (deliveryWanted && row['delivery_time'] == null) missing.push('delivery_time')
  /**
   * A customer collecting still has a time. Live: "collection it is",
   * "Confirmed", and nobody ever learned when they were coming for the car —
   * a Ferrari prepared for nobody, or nobody there when they arrive. Stored
   * in the same column: it is the handover time either way.
   */
  if (handoverKnown && !deliveryWanted && row['delivery_time'] == null) missing.push('collection_time')
  // A returning customer's checked documents stand for a year; asking again is
  // asking them to prove who they are to people who already know.
  if (documents < DOCUMENTS_WANTED && row['documents_checked_at'] == null && row['on_file'] == null) {
    missing.push('documents')
  }
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

  /**
   * The other end, once it is near. Asked the day before, not at booking: on
   * Tuesday nobody knows what time on Sunday suits, and a question asked five
   * days early is asked again anyway.
   */
  if (row['return_is_near'] === true && row['returned_at'] == null) {
    if (row['return_time'] == null) missing.push('return_time')
    if (deliveryWanted && row['return_address'] == null) missing.push('return_address')
  }

  return {
    bookingId: row['id'] as string,
    enquiryId: (row['enquiry_id'] as string) ?? null,
    handover: deliveryWanted ? 'delivery' : handoverKnown ? 'collection' : null,
    vehicle: (row['vehicle'] as string) ?? null,
    startDate: (row['start_date'] as string) ?? null,
    endDate: (row['end_date'] as string) ?? null,
    days: row['days'] == null ? null : Number(row['days']),
    totalMinor: Number(row['total_minor']),
    depositMinor: row['deposit_minor'] == null ? null : Number(row['deposit_minor']),
    deliveryWanted,
    deliveryAddress: (row['delivery_address'] as string) ?? null,
    deliveryTime: (row['delivery_time'] as string) ?? null,
    paymentPlan: plan,
    customerReportedPaidAt: row['customer_reported_paid_at'] == null
      ? null : new Date(row['customer_reported_paid_at'] as string),
    documents,
    documentsCheckedAt: row['documents_checked_at'] == null
      ? null : new Date(row['documents_checked_at'] as string),
    documentsOnFileFrom: row['on_file'] == null ? null : new Date(row['on_file'] as string),
    owedMinor: owed,
    currency: row['currency'] as string,
    paymentLink: (row['link'] as string) ?? null,
    paidMinor: Number(row['paid']),
    addOns: (row['add_ons'] as Array<{ label: string; amountMinor: number }> | null) ?? [],
    returnTime: (row['return_time'] as string) ?? null,
    returnAddress: (row['return_address'] as string) ?? null,
    returnedAt: row['returned_at'] == null ? null : new Date(row['returned_at'] as string),
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
       and b.returned_at is null
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
    /**
     * They switched between delivery and collection, so a time given for the
     * other one no longer stands. Live: 4pm was said for a collection, the
     * customer then chose delivery, and 4pm quietly became the delivery time.
     */
    clearTime?: boolean
    returnTime?: string | null
    returnAddress?: string | null
  },
): Promise<{ recorded: boolean }> {
  const rows = await run(
    `update bookings
     set delivery_address = coalesce($3, delivery_address),
         delivery_time = case when $7 then $4 else coalesce($4, delivery_time) end,
         payment_plan = coalesce($5, payment_plan),
         customer_reported_paid_at = case when $6 then coalesce(customer_reported_paid_at, now())
                                          else customer_reported_paid_at end,
         return_time = coalesce($8, return_time),
         return_address = coalesce($9, return_address),
         updated_at = now()
     where id = $1 and operator_id = $2 and state = 'confirmed'
     returning id`,
    [
      input.bookingId, input.operatorId,
      input.deliveryAddress ?? null, input.deliveryTime ?? null,
      input.paymentPlan ?? null, input.saysPaid === true, input.clearTime === true,
      input.returnTime ?? null, input.returnAddress ?? null,
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

/**
 * Every photo or file sent since the booking was confirmed that is not on it
 * yet — not only the message this job happens to be about.
 *
 * Messages that arrive together are answered once, from the newest, which is
 * right for "can you" / "send" / "more photos" and wrong for two photographs
 * a second apart. Live: a licence and an Emirates ID arrived 0.7s apart, the
 * older one's job gave way to the newer, and the booking held one of them. The
 * customer was asked for "the other one" three times and had already sent it.
 */
export async function fileWaitingDocuments(
  run: QueryRunner,
  input: { operatorId: string; bookingId: string; conversationId: string },
): Promise<{ filed: number; total: number }> {
  const filed = await run(
    `insert into booking_documents (operator_id, booking_id, conversation_id, message_id)
     select m.operator_id, b.id, m.conversation_id, m.id
     from messages m
     join bookings b on b.id = $2 and b.operator_id = m.operator_id
     where m.operator_id = $1 and m.conversation_id = $3
       and m.direction = 'inbound' and m.kind in ('image', 'document')
       and m.created_at >= coalesce(b.decided_at, b.created_at)
       and not exists (select 1 from booking_documents d where d.message_id = m.id)
     order by m.created_at
     on conflict do nothing
     returning message_id`,
    [input.operatorId, input.bookingId, input.conversationId],
  )
  const [row] = await run(
    `select count(*)::int as n from booking_documents where booking_id = $1 and operator_id = $2`,
    [input.bookingId, input.operatorId],
  )
  return { filed: filed.length, total: Number(row?.['n'] ?? 0) }
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

/**
 * A person saw the car come back.
 *
 * Their name goes on it, as it does on the documents: "returned" with nobody
 * against it is a claim, and the deposit is given back on the strength of it.
 */
export async function markReturned(
  run: QueryRunner,
  input: { operatorId: string; bookingId: string; membershipId: string },
): Promise<{ returned: boolean; conversationId: string | null }> {
  const rows = await run(
    `update bookings
     set returned_at = now(), returned_by_membership_id = $3, updated_at = now()
     where id = $1 and operator_id = $2 and state = 'confirmed' and returned_at is null
     returning conversation_id`,
    [input.bookingId, input.operatorId, input.membershipId],
  )
  return {
    returned: rows.length > 0,
    conversationId: (rows[0]?.['conversation_id'] as string) ?? null,
  }
}

import type { QueryRunner } from '../runner.js'

/**
 * What this business already knows about somebody who has rented before.
 *
 * A returning customer used to be treated as a stranger: asked where they are
 * from, asked for the licence a colleague checked last month, asked for the
 * address the car went to last time. A person behind the desk would remember;
 * the record does, so the agent can.
 *
 * By contact rather than conversation: a thread reopens for years, but the
 * person is the same one whether they come back to it or start another.
 */
export type CustomerHistory = {
  rentals: Array<{
    vehicle: string | null
    startDate: string
    handover: 'delivery' | 'collection' | null
    deliveryAddress: string | null
  }>
  /** The latest time a person checked their documents, within the last year. */
  documentsCheckedAt: Date | null
  /** What they said last time: resident, visitor, where from. */
  residency: string | null
}

/** Documents checked within this long are trusted for the next rental. */
export const DOCUMENTS_VALID_DAYS = 365

export async function customerHistory(
  run: QueryRunner,
  input: { operatorId: string; contactId: string; excludingBookingId?: string | null },
): Promise<CustomerHistory> {
  const rentals = await run(
    `select trim(v.make || ' ' || v.model || ' ' || coalesce(v.variant, '')) as vehicle,
            q.start_date::date::text as start_date, b.delivery_address,
            (select fe.value from field_evidence fe
              where fe.enquiry_id = b.enquiry_id and fe.field = 'delivery_preference'
                and fe.superseded_at is null limit 1) as preference
     from bookings b
     join conversations c on c.id = b.conversation_id and c.operator_id = b.operator_id
     join quotes q on q.id = b.quote_id and q.operator_id = b.operator_id
     left join vehicles v on v.id = q.vehicle_id
     where b.operator_id = $1 and c.contact_id = $2 and b.state = 'confirmed'
       and b.id is distinct from $3::uuid
       -- Rentals that have happened: somebody with only an upcoming booking
       -- is not coming back yet.
       and (q.start_date::date < current_date or b.returned_at is not null)
     order by q.start_date desc
     limit 3`,
    [input.operatorId, input.contactId, input.excludingBookingId ?? null],
  )
  const [checked] = await run(
    `select max(b.documents_checked_at) as at
     from bookings b join conversations c on c.id = b.conversation_id and c.operator_id = b.operator_id
     where b.operator_id = $1 and c.contact_id = $2 and b.id is distinct from $3::uuid
       and b.documents_checked_at > now() - make_interval(days => $4)`,
    [input.operatorId, input.contactId, input.excludingBookingId ?? null, DOCUMENTS_VALID_DAYS],
  )
  const [residency] = await run(
    `select fe.value from field_evidence fe
     join enquiries e on e.id = fe.enquiry_id and e.operator_id = fe.operator_id
     join conversations c on c.id = e.conversation_id and c.operator_id = e.operator_id
     where fe.operator_id = $1 and c.contact_id = $2 and fe.field = 'residency' and fe.superseded_at is null
     order by fe.created_at desc limit 1`,
    [input.operatorId, input.contactId],
  )
  return {
    rentals: rentals.map((r) => {
      const preference = String(r['preference'] ?? '')
      return {
        vehicle: (r['vehicle'] as string) ?? null,
        startDate: r['start_date'] as string,
        handover: /deliver/i.test(preference) ? 'delivery' as const
          : /collect|pick/i.test(preference) ? 'collection' as const : null,
        deliveryAddress: (r['delivery_address'] as string) ?? null,
      }
    }),
    documentsCheckedAt: checked?.['at'] == null ? null : new Date(checked['at'] as string),
    residency: (residency?.['value'] as string) ?? null,
  }
}

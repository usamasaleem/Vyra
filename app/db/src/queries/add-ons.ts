import type { Transactor } from '../runner.js'

/**
 * Something extra on a booking, at the operator's own price.
 *
 * Offered once after "Booked" — a chauffeur, more kilometres — and added when
 * the customer wants it: a row of its own on the payments, labelled the way
 * the customer reads it ("Chauffeur, 3 days"), owed like the rental. The price
 * is the operator's list, never the model's: the agent names which add-on and
 * nothing else.
 */
export type AddOn = { id: string; name: string; priceMinor: number; per: 'day' | 'rental' }

export type AddedOn =
  | { ok: true; label: string; amountMinor: number; currency: string; owedMinor: number }
  | { ok: false; reason: 'no_booking' | 'unknown' | 'already_added'; detail: string }

export async function addToBooking(
  transact: Transactor,
  input: { operatorId: string; bookingId: string; addOnId: string },
): Promise<AddedOn> {
  return transact(async (tx) => {
    const [row] = await tx(
      `select b.id, b.conversation_id, q.days, q.currency, o.add_ons
       from bookings b
       join quotes q on q.id = b.quote_id and q.operator_id = b.operator_id
       join operators o on o.id = b.operator_id
       where b.id = $1 and b.operator_id = $2 and b.state = 'confirmed'
       for update of b`,
      [input.bookingId, input.operatorId],
    )
    if (row === undefined) {
      return { ok: false as const, reason: 'no_booking' as const, detail: 'There is no confirmed booking to add it to.' }
    }
    const addOn = ((row['add_ons'] as AddOn[] | null) ?? []).find((a) => a.id === input.addOnId)
    if (addOn === undefined) {
      return { ok: false as const, reason: 'unknown' as const, detail: 'That is not one of the add-ons this operator offers.' }
    }

    const [already] = await tx(
      `select 1 from payments where booking_id = $1 and operator_id = $2 and kind = 'add_on'
         and state in ('due', 'paid') and label like $3 || '%'`,
      [input.bookingId, input.operatorId, addOn.name],
    )
    if (already !== undefined) {
      return { ok: false as const, reason: 'already_added' as const, detail: `${addOn.name} is already on this booking.` }
    }

    const days = Math.max(1, Number(row['days'] ?? 1))
    const amountMinor = addOn.per === 'day' ? addOn.priceMinor * days : addOn.priceMinor
    const label = addOn.per === 'day' ? `${addOn.name}, ${days} day${days === 1 ? '' : 's'}` : addOn.name
    await tx(
      `insert into payments (operator_id, booking_id, conversation_id, kind, state, amount_minor, currency, label)
       values ($1, $2, $3, 'add_on', 'due', $4, $5, $6)`,
      [input.operatorId, input.bookingId, row['conversation_id'], amountMinor, row['currency'], label],
    )
    const [owed] = await tx(
      `select coalesce(sum(amount_minor), 0)::bigint as owed from payments
       where booking_id = $1 and operator_id = $2 and state = 'due'`,
      [input.bookingId, input.operatorId],
    )
    return {
      ok: true as const, label, amountMinor, currency: row['currency'] as string,
      owedMinor: Number(owed?.['owed'] ?? 0),
    }
  })
}

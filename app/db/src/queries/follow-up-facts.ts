import { formatDateForMessage } from '@vyra/contracts'
import type { QueryRunner } from '../runner.js'
import { checkCalendar } from './availability.js'
import { activeHoldFor } from './holds.js'
import { formatMoney } from './quotes.js'

/**
 * What a chase can say about the car, checked at the moment it goes.
 *
 * "Still thinking it over?" asks the customer to remember what they were
 * thinking about. A salesperson following up says which car, which dates, what
 * it costs, and — the reason to answer today — that it is still available, or
 * held for them until six. The operator's words stay the opening line; this is
 * the record's part underneath, like the figures under a quote.
 *
 * Checked now rather than recalled: a car that was available when quoted and
 * has been booked since must not be offered in the chase. Null when there is
 * no live price to talk about, and the chase goes as the operator wrote it.
 */
export type FollowUpFacts = {
  text: string
  /** The car and the dates, plainly, for a follow-up sent as a template. */
  vehicle: string
  dates: string
  /** What the car is doing now, which decides the buttons under the chase. */
  state: 'available' | 'held' | 'taken' | 'unknown'
}

const day = (civil: string) => formatDateForMessage(new Date(`${civil}T12:00:00Z`), 'UTC')

export async function followUpFacts(
  run: QueryRunner,
  input: { operatorId: string; conversationId: string; now?: Date },
): Promise<FollowUpFacts | null> {
  const [quote] = await run(
    `select q.id, q.vehicle_id, q.currency, q.total_minor,
            q.start_date::date::text as start_date,
            coalesce(q.end_date, q.start_date)::date::text as end_date,
            trim(v.make || ' ' || v.model || ' ' || coalesce(v.variant, '')) as vehicle,
            o.timezone
     from quotes q
     join operators o on o.id = q.operator_id
     left join vehicles v on v.id = q.vehicle_id and v.operator_id = q.operator_id
     where q.operator_id = $1 and q.conversation_id = $2
       and q.state in ('draft', 'approved', 'sent')
       and (q.valid_until is null or q.valid_until > now())
       and q.vehicle_id is not null and q.start_date is not null
       and not exists (select 1 from bookings b where b.quote_id = q.id
                         and b.state in ('requested', 'confirmed'))
     order by q.revision desc
     limit 1`,
    [input.operatorId, input.conversationId],
  )
  if (quote === undefined) return null

  const vehicle = (quote['vehicle'] as string) ?? 'the car'
  const start = quote['start_date'] as string
  const end = quote['end_date'] as string
  const dates = end === start ? day(start) : `${day(start)} to ${day(end)}`
  const price = formatMoney(Number(quote['total_minor']), quote['currency'] as string)

  const hold = await activeHoldFor(run, { operatorId: input.operatorId, conversationId: input.conversationId })
  if (hold !== null && hold.quoteId === quote['id']) {
    const tz = quote['timezone'] as string
    const civil = (d: Date) => new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(d)
    const time = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).format(hold.until)
    const when = civil(hold.until) === civil(input.now ?? new Date()) ? `${time} today` : `${time} tomorrow`
    return {
      text: `*${vehicle}*, ${dates} — ${price}. Still held for you until ${when}.`,
      state: 'held', vehicle, dates,
    }
  }

  const calendar = await checkCalendar(run, {
    operatorId: input.operatorId,
    vehicleId: quote['vehicle_id'] as string,
    startDate: start,
    endDate: end,
    conversationId: input.conversationId,
  })

  if (calendar.state === 'booked') {
    return {
      text: `The *${vehicle}* has since been booked for ${dates}. Tell me other dates, or I can `
        + 'suggest another car.',
      state: 'taken', vehicle, dates,
    }
  }
  if (calendar.state === 'free') {
    return { text: `*${vehicle}*, ${dates} — ${price}. Still available.`, state: 'available', vehicle, dates }
  }
  return { text: `*${vehicle}*, ${dates} — ${price}.`, state: 'unknown', vehicle, dates }
}

import { formatDateForMessage, HIGHLIGHT_LIMIT } from '@vyra/contracts'
import type { QueryRunner } from '../runner.js'

/**
 * Calculating a draft quote.
 *
 * Section 18.9: Sales may request a draft quote; Operations owns the
 * calculation, and Sales cannot turn an estimate into a booking. So this
 * produces a `draft` and stops. A person moves it to `approved`, and only then
 * does a figure reach a customer.
 *
 * The agent is never told the numbers in a draft. That is not caution about
 * this particular model — it is that a model cannot leak a figure it was never
 * given, which is a stronger guarantee than any instruction about what not to
 * say.
 *
 * Arithmetic is integer fils throughout. The one place a float would be
 * tempting is the weekly rate, and that is exactly where a rounding error
 * becomes a number the operator has to explain.
 */

export type QuoteLine = { label: string; amountMinor: number; detail?: string }

export type DraftQuote = {
  quoteId: string
  revision: number
  currency: string
  totalMinor: number
  depositMinor: number | null
  lines: QuoteLine[]
  days: number
  validUntil: Date
}

export type QuoteRefusal =
  | { reason: 'no_confirmed_rate'; detail: string }
  | { reason: 'below_minimum_days'; detail: string }
  | { reason: 'no_dates'; detail: string }
  | { reason: 'no_vehicle'; detail: string }

export type QuoteResult =
  | { ok: true; quote: DraftQuote }
  | { ok: false; refusal: QuoteRefusal }

/**
 * How long a draft price is honoured.
 *
 * A quote with no expiry is a promise with no end, and section 18.6 lists
 * `valid_until` as part of what makes a quote a commercial version rather than
 * a number in a chat.
 */
const QUOTE_VALID_HOURS = 48

export async function calculateDraftQuote(
  run: QueryRunner,
  input: {
    operatorId: string
    conversationId: string
    enquiryId: string | null
    vehicleId: string | null
    startDate: string | null
    endDate: string | null
  },
): Promise<QuoteResult> {
  if (input.vehicleId === null) {
    return { ok: false, refusal: { reason: 'no_vehicle', detail: 'No confirmed vehicle to price.' } }
  }
  if (input.startDate === null || input.endDate === null) {
    return {
      ok: false,
      refusal: { reason: 'no_dates', detail: 'A quote needs a start and an end date.' },
    }
  }

  const days = Math.max(
    1,
    Math.round(
      (Date.parse(`${input.endDate}T00:00:00Z`) - Date.parse(`${input.startDate}T00:00:00Z`)) /
        86_400_000,
    ),
  )

  const rateRows = await run(
    `select id, currency, daily_rate_minor, weekly_rate_minor, monthly_rate_minor,
            minimum_days, included_km_per_day, extra_km_rate_minor, deposit_minor,
            delivery_fee_minor
     from vehicle_rates
     where operator_id = $1 and vehicle_id = $2
       -- Confirmed only. An unconfirmed rate is a number nobody at the operator
       -- has stood behind, and using it is the failure this system exists to
       -- prevent.
       and provenance = 'operator_confirmed'
       and effective_to is null
     limit 1`,
    [input.operatorId, input.vehicleId],
  )

  const rate = rateRows[0]
  if (rate === undefined) {
    return {
      ok: false,
      refusal: {
        reason: 'no_confirmed_rate',
        detail: 'This vehicle has no confirmed rate. Operations must set one before it can be priced.',
      },
    }
  }

  const minimumDays = Number(rate['minimum_days'] ?? 1)
  if (days < minimumDays) {
    return {
      ok: false,
      refusal: {
        reason: 'below_minimum_days',
        detail: `This vehicle has a ${minimumDays}-day minimum; the request is ${days}.`,
      },
    }
  }

  const daily = Number(rate['daily_rate_minor'])
  const weekly = rate['weekly_rate_minor'] == null ? null : Number(rate['weekly_rate_minor'])
  const monthly = rate['monthly_rate_minor'] == null ? null : Number(rate['monthly_rate_minor'])

  /**
   * Tiered pricing, cheapest honest total.
   *
   * Whole weeks and months at their own rate, the remainder daily. The customer
   * is charged the operator's own published tier rather than the arithmetic
   * that happens to suit — and there is no discount input anywhere in this
   * function, because a discount is a manager's approval (section 18.7), not a
   * calculation.
   */
  const lines: QuoteLine[] = []
  let remaining = days
  let rental = 0

  if (monthly !== null && remaining >= 30) {
    const months = Math.floor(remaining / 30)
    rental += months * monthly
    remaining -= months * 30
    lines.push({ label: `${months} month${months > 1 ? 's' : ''}`, amountMinor: months * monthly })
  }
  if (weekly !== null && remaining >= 7) {
    const weeks = Math.floor(remaining / 7)
    rental += weeks * weekly
    remaining -= weeks * 7
    lines.push({ label: `${weeks} week${weeks > 1 ? 's' : ''}`, amountMinor: weeks * weekly })
  }
  if (remaining > 0) {
    rental += remaining * daily
    lines.push({ label: `${remaining} day${remaining > 1 ? 's' : ''}`, amountMinor: remaining * daily })
  }

  const delivery = rate['delivery_fee_minor'] == null ? 0 : Number(rate['delivery_fee_minor'])
  if (delivery > 0) lines.push({ label: 'Delivery and collection', amountMinor: delivery })

  const totalMinor = rental + delivery
  const depositMinor = rate['deposit_minor'] == null ? null : Number(rate['deposit_minor'])

  const validUntil = new Date(Date.now() + QUOTE_VALID_HOURS * 3_600_000)

  /**
   * Supersede before inserting, in one statement and in that order.
   *
   * A data-modifying CTE shares one snapshot, so the partial unique index would
   * still see the old draft as current if both happened together. This project
   * has learned that twice — publishing knowledge and superseding field
   * evidence both needed the same ordering.
   */
  await run(
    `update quotes set state = 'superseded', updated_at = now()
     where conversation_id = $1 and operator_id = $2 and state = 'draft'`,
    [input.conversationId, input.operatorId],
  )

  const inserted = await run(
    `insert into quotes (
       operator_id, conversation_id, enquiry_id, vehicle_id, revision, state,
       currency, total_minor, deposit_minor, lines, start_date, end_date, days,
       rate_id, valid_until
     )
     select $1, $2, $3::uuid, $4::uuid,
            coalesce((select max(revision) from quotes
                      where conversation_id = $2 and operator_id = $1), 0) + 1,
            'draft', $5, $6, $7::int, $8::jsonb, $9::timestamptz, $10::timestamptz, $11,
            $12::uuid, $13::timestamptz
     returning id, revision`,
    [
      input.operatorId, input.conversationId, input.enquiryId, input.vehicleId,
      rate['currency'] as string, totalMinor, depositMinor, JSON.stringify(lines),
      `${input.startDate}T00:00:00Z`, `${input.endDate}T00:00:00Z`, days,
      rate['id'] as string, validUntil.toISOString(),
    ],
  )

  const row = inserted[0]!
  return {
    ok: true,
    quote: {
      quoteId: row['id'] as string,
      revision: Number(row['revision']),
      currency: rate['currency'] as string,
      totalMinor,
      depositMinor,
      lines,
      days,
      validUntil,
    },
  }
}

/** Fils to a readable amount. The only place money becomes a string. */
export function formatMoney(minor: number, currency: string): string {
  const major = (minor / 100).toLocaleString('en-AE', {
    minimumFractionDigits: minor % 100 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  })
  return `${currency} ${major}`
}

export type PendingQuote = {
  id: string
  conversationId: string
  revision: number
  currency: string
  totalMinor: number
  depositMinor: number | null
  lines: QuoteLine[]
  days: number
  validUntil: Date | null
  customerName: string | null
  whatsappNumber: string
  vehicleLabel: string | null
}

export async function listDraftQuotes(
  run: QueryRunner,
  operatorId: string,
): Promise<PendingQuote[]> {
  const rows = await run(
    `select q.id, q.conversation_id, q.revision, q.currency, q.total_minor, q.deposit_minor,
            q.lines, q.days, q.valid_until,
            c.display_name, c.channel_identifier,
            case when v.id is null then null
                 else v.make || ' ' || v.model || coalesce(' ' || v.variant, '') end as vehicle_label
     from quotes q
     join conversations conv on conv.id = q.conversation_id and conv.operator_id = q.operator_id
     join contacts c on c.id = conv.contact_id and c.operator_id = q.operator_id
     left join vehicles v on v.id = q.vehicle_id and v.operator_id = q.operator_id
     where q.operator_id = $1 and q.state = 'draft'
     order by q.created_at`,
    [operatorId],
  )

  return rows.map((r) => ({
    id: r['id'] as string,
    conversationId: r['conversation_id'] as string,
    revision: Number(r['revision']),
    currency: r['currency'] as string,
    totalMinor: Number(r['total_minor']),
    depositMinor: r['deposit_minor'] == null ? null : Number(r['deposit_minor']),
    lines: (r['lines'] ?? []) as QuoteLine[],
    days: Number(r['days'] ?? 0),
    validUntil: r['valid_until'] == null ? null : new Date(r['valid_until'] as string),
    customerName: (r['display_name'] as string) ?? null,
    whatsappNumber: r['channel_identifier'] as string,
    vehicleLabel: (r['vehicle_label'] as string) ?? null,
  }))
}

/**
 * Approving a quote, which is the moment a figure becomes something the
 * operator owes.
 *
 * Version-bound: the approver names the revision they read, and approving a
 * different one fails rather than approving whatever is newest. Section 18.12
 * calls this "role check and version-bound approval", and the failure it
 * prevents is a quote being revised between someone reading it and clicking
 * approve.
 */
export async function approveQuote(
  run: QueryRunner,
  input: { quoteId: string; operatorId: string; membershipId: string; revision: number },
): Promise<{ approved: boolean; reason: 'ok' | 'not_found' | 'revision_moved' | 'expired' }> {
  const rows = await run(
    `with approved as (
       update quotes
       set state = 'approved', approved_by_membership_id = $3, approved_at = now(),
           updated_at = now()
       where id = $1 and operator_id = $2 and state = 'draft' and revision = $4
         and (valid_until is null or valid_until > now())
       returning id, operator_id, revision, total_minor
     ),
     audited as (
       insert into audit_events (
         operator_id, actor_type, actor_id, action, subject_type, subject_id,
         subject_version, data
       )
       select a.operator_id, 'user', $3, 'quote.approved', 'quote', a.id, a.revision,
              jsonb_build_object('total_minor', a.total_minor)
       from approved a
       returning id
     )
     select (select id from approved) as approved_id,
            (select revision from quotes where id = $1 and operator_id = $2) as current_revision,
            (select state::text from quotes where id = $1 and operator_id = $2) as current_state,
            (select valid_until < now() from quotes where id = $1 and operator_id = $2) as is_expired`,
    [input.quoteId, input.operatorId, input.membershipId, input.revision],
  )

  const row = rows[0]
  if (row?.['approved_id'] != null) return { approved: true, reason: 'ok' }
  if (row?.['current_revision'] == null) return { approved: false, reason: 'not_found' }
  if (row['is_expired'] === true) return { approved: false, reason: 'expired' }
  return { approved: false, reason: 'revision_moved' }
}

export type RateRow = {
  vehicleId: string
  vehicleLabel: string
  rateId: string | null
  currency: string
  dailyRateMinor: number | null
  weeklyRateMinor: number | null
  monthlyRateMinor: number | null
  minimumDays: number | null
  includedKmPerDay: number | null
  extraKmRateMinor: number | null
  depositMinor: number | null
  deliveryFeeMinor: number | null
  confirmedBy: string | null
  /** Photographs of this car, shown to a customer asking about it. */
  photoUrls: string[]
  /** A few words the operator wants beside it. Their claim, not ours. */
  highlight: string | null
}

/**
 * Every confirmed vehicle, with its current rate or nothing.
 *
 * A left join rather than a list of rates, so a car with no price is visible
 * instead of absent. A missing rate is the reason the agent refuses to quote,
 * and a page that only lists what exists cannot show you what does not.
 */
export async function listRates(run: QueryRunner, operatorId: string): Promise<RateRow[]> {
  const rows = await run(
    `select v.id as vehicle_id, v.photo_urls, v.highlight,
            v.make || ' ' || v.model || coalesce(' ' || v.variant, '') ||
              ' · ' || v.colour as vehicle_label,
            r.id as rate_id, coalesce(r.currency, 'AED') as currency,
            r.daily_rate_minor, r.weekly_rate_minor, r.monthly_rate_minor, r.minimum_days,
            r.included_km_per_day, r.extra_km_rate_minor, r.deposit_minor,
            r.delivery_fee_minor, r.confirmed_by
     from vehicles v
     left join vehicle_rates r
       on r.vehicle_id = v.id and r.operator_id = v.operator_id
      and r.effective_to is null and r.provenance = 'operator_confirmed'
     where v.operator_id = $1 and v.active and v.provenance = 'operator_confirmed'
     order by v.make, v.model`,
    [operatorId],
  )

  return rows.map((r) => ({
    vehicleId: r['vehicle_id'] as string,
    vehicleLabel: r['vehicle_label'] as string,
    photoUrls: (r['photo_urls'] as string[] | null) ?? [],
    rateId: (r['rate_id'] as string) ?? null,
    currency: r['currency'] as string,
    dailyRateMinor: r['daily_rate_minor'] == null ? null : Number(r['daily_rate_minor']),
    weeklyRateMinor: r['weekly_rate_minor'] == null ? null : Number(r['weekly_rate_minor']),
    monthlyRateMinor: r['monthly_rate_minor'] == null ? null : Number(r['monthly_rate_minor']),
    minimumDays: r['minimum_days'] == null ? null : Number(r['minimum_days']),
    includedKmPerDay: r['included_km_per_day'] == null ? null : Number(r['included_km_per_day']),
    extraKmRateMinor: r['extra_km_rate_minor'] == null ? null : Number(r['extra_km_rate_minor']),
    depositMinor: r['deposit_minor'] == null ? null : Number(r['deposit_minor']),
    deliveryFeeMinor: r['delivery_fee_minor'] == null ? null : Number(r['delivery_fee_minor']),
    confirmedBy: (r['confirmed_by'] as string) ?? null,
    highlight: (r['highlight'] as string) ?? null,
  }))
}

/**
 * Recording a rate, which supersedes rather than edits.
 *
 * The old row keeps its window, so a quote raised last week can still be
 * explained by the rate that was in force when it was raised. Editing in place
 * would make an old quote unexplainable, which is the same mistake as a
 * mutable knowledge answer.
 *
 * `confirmedBy` is required by the caller and enforced by a check constraint.
 * A rate with no name against it is exactly the unattributable figure the whole
 * provenance mechanism exists to prevent.
 */
export async function setVehicleRate(
  run: QueryRunner,
  input: {
    operatorId: string
    vehicleId: string
    confirmedBy: string
    currency?: string
    dailyRateMinor: number
    weeklyRateMinor?: number | null
    monthlyRateMinor?: number | null
    minimumDays?: number
    includedKmPerDay?: number | null
    extraKmRateMinor?: number | null
    depositMinor?: number | null
    deliveryFeeMinor?: number | null
  },
): Promise<{ rateId: string }> {
  // Close the current row first. A data-modifying CTE would share a snapshot
  // and the partial unique index would still see the old row as current.
  await run(
    `update vehicle_rates set effective_to = now()
     where operator_id = $1 and vehicle_id = $2 and effective_to is null`,
    [input.operatorId, input.vehicleId],
  )

  const rows = await run(
    `insert into vehicle_rates (
       operator_id, vehicle_id, currency, daily_rate_minor, weekly_rate_minor,
       monthly_rate_minor, minimum_days, included_km_per_day, extra_km_rate_minor,
       deposit_minor, delivery_fee_minor, provenance, confirmed_by, confirmed_at
     ) values ($1,$2,$3,$4,$5::int,$6::int,$7,$8::int,$9::int,$10::int,$11::int,
               'operator_confirmed',$12,now())
     returning id`,
    [
      input.operatorId, input.vehicleId, input.currency ?? 'AED', input.dailyRateMinor,
      input.weeklyRateMinor ?? null, input.monthlyRateMinor ?? null, input.minimumDays ?? 1,
      input.includedKmPerDay ?? null, input.extraKmRateMinor ?? null,
      input.depositMinor ?? null, input.deliveryFeeMinor ?? null, input.confirmedBy,
    ],
  )
  return { rateId: rows[0]!['id'] as string }
}

/**
 * The customer-facing quote, rendered from the stored figures.
 *
 * Section 18.8: "For material commercial messages, render amounts, dates,
 * expiry and status from validated database fields. Let the model phrase the
 * surrounding explanation." This is that rendering, and it is the only place a
 * price becomes words a customer reads.
 */
export function renderQuoteMessage(quote: {
  currency: string
  lines: QuoteLine[]
  totalMinor: number
  depositMinor: number | null
  days: number
  validUntil: Date | null
  /** For the expiry date. Defaults to the pilot's, which is where this began. */
  timezone?: string
}): string {
  const money = (minor: number) => formatMoney(minor, quote.currency)

  /**
   * The total is a line of its own only when it is telling the customer
   * something they cannot already see.
   *
   * Live, a nineteen-day rental went out as "19 days: AED 104,500" followed by
   * "Total: AED 104,500" — the same number twice, which reads as a system
   * padding rather than as a quote.
   */
  const onlyLine = quote.lines.length === 1 && quote.lines[0]!.amountMinor === quote.totalMinor

  const parts = quote.lines.map((l) => `${l.label}: ${money(l.amountMinor)}`)

  // Bold, because it is the number the whole message is about. One asterisk:
  // WhatsApp renders that and shows the asterisks for Markdown's two.
  if (!onlyLine) parts.push(`*Total: ${money(quote.totalMinor)}*`)
  else parts[0] = `*${parts[0]}*`

  if (quote.depositMinor !== null) {
    parts.push(`Refundable deposit: ${money(quote.depositMinor)}`)
  }
  if (quote.validUntil !== null) {
    /**
     * An expiry the customer can see, because a price with no end is a promise
     * with no end — written the way a person writes a date.
     *
     * It was an ISO string, which is the exact thing the instructions forbid
     * the model from doing: "Valid until 2026-09-17" reached a customer. A
     * rule enforced on the model and not on ourselves is half a rule.
     */
    parts.push(`Valid until ${formatDateForMessage(quote.validUntil, quote.timezone ?? 'Asia/Dubai')}.`)
  }
  return parts.join('\n')
}

/**
 * A few words the operator wants beside a car.
 *
 * On the vehicle rather than the rate, because it is a claim about the car and
 * not about what it costs — and because a rate supersedes rather than edits,
 * which would mean losing the highlight every time somebody changed a price.
 *
 * Audited like the rate beside it. "Best seller" is a statement about the
 * business that customers read in the operator's voice, and who said it is
 * worth keeping.
 */
export async function setVehicleHighlight(
  run: QueryRunner,
  input: {
    operatorId: string
    vehicleId: string
    highlight: string | null
    actorMembershipId: string
  },
): Promise<{ changed: boolean }> {
  const trimmed = input.highlight === null ? null : input.highlight.trim()
  const value = trimmed === null || trimmed === '' ? null : trimmed.slice(0, HIGHLIGHT_LIMIT)

  const rows = await run(
    `update vehicles set highlight = $3
     where id = $1 and operator_id = $2 and active and provenance = 'operator_confirmed'
     returning id`,
    [input.vehicleId, input.operatorId, value],
  )
  if (rows.length === 0) return { changed: false }

  await run(
    `insert into audit_events (operator_id, actor_type, actor_id, action, subject_type, subject_id, data)
     values ($1, 'user', $2, 'vehicle.highlight_set', 'vehicle', $3, $4::jsonb)`,
    [input.operatorId, input.actorMembershipId, input.vehicleId, JSON.stringify({ highlight: value })],
  )
  return { changed: true }
}

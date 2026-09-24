import type { Transactor } from '../runner.js'

/**
 * Money off that the operator has already agreed to give.
 *
 * "Too expensive" used to go to a person every time, and the customer waited
 * on a decision the operator had in effect already made: a week's rental gets
 * something off. The tiers are theirs (Settings → When the price is the
 * objection); the agent applies the best one a rental reaches, once, and says
 * the new total. Anything beyond the tiers is still a person's call.
 *
 * A new revision, like a salesperson's discount: the old price stays on file,
 * the reduction is its own line, and the reason names the rule it came from.
 * Approved under whoever set the tiers: nobody pressed a button for this quote,
 * but somebody decided this offer, and every discount carries a name.
 */
export type StandingDiscount =
  | {
    ok: true
    quoteId: string
    percent: number
    minDays: number
    currency: string
    totalMinor: number
    discountMinor: number
    depositMinor: number | null
  }
  | {
    ok: false
    reason: 'no_quote' | 'no_rules' | 'not_eligible' | 'already_discounted'
    /** The next tier up, when a longer rental would reach one. */
    nextTier?: { minDays: number; percent: number }
    detail: string
  }

export async function applyStandingDiscount(
  transact: Transactor,
  input: { operatorId: string; conversationId: string; quoteId: string },
): Promise<StandingDiscount> {
  if (!/^[0-9a-f-]{36}$/i.test(input.quoteId)) {
    return { ok: false, reason: 'no_quote', detail: 'That is not a quote id. Pass the quoteId prepare_quote returned.' }
  }
  return transact(async (tx) => {
    const [quote] = await tx(
      `select q.*, o.discount_tiers, o.discount_tiers_set_by_membership_id
       from quotes q join operators o on o.id = q.operator_id
       where q.id = $1 and q.operator_id = $2 and q.conversation_id = $3
       for update of q`,
      [input.quoteId, input.operatorId, input.conversationId],
    )
    if (quote === undefined || !['draft', 'approved', 'sent'].includes(quote['state'] as string)
      || (quote['valid_until'] != null && new Date(quote['valid_until'] as string) <= new Date())) {
      return { ok: false as const, reason: 'no_quote' as const, detail: 'That price is not current. Price it again first.' }
    }
    const tiers = ((quote['discount_tiers'] as Array<{ minDays: number; percent: number }> | null) ?? [])
      .filter((t) => Number.isInteger(t.minDays) && Number.isInteger(t.percent))
    if (tiers.length === 0 || quote['discount_tiers_set_by_membership_id'] == null) {
      return { ok: false as const, reason: 'no_rules' as const, detail: 'This operator gives no discounts by itself.' }
    }
    if (quote['discount_minor'] != null && Number(quote['discount_minor']) > 0) {
      return {
        ok: false as const, reason: 'already_discounted' as const,
        detail: 'This price already has money off. Anything more is a person’s decision.',
      }
    }

    const days = Number(quote['days'])
    const reached = tiers.filter((t) => days >= t.minDays).sort((a, b) => b.percent - a.percent)[0]
    if (reached === undefined) {
      const nextTier = tiers.filter((t) => t.minDays > days).sort((a, b) => a.minDays - b.minDays)[0]
      return {
        ok: false as const, reason: 'not_eligible' as const,
        ...(nextTier === undefined ? {} : { nextTier }),
        detail: `No discount reaches a ${days}-day rental.`,
      }
    }

    const before = Number(quote['total_minor'])
    // Whole currency, rounded down in the customer's favour — "AED 1,650", not "AED 1,649.85".
    const discountMinor = Math.floor((before * reached.percent) / 100 / 100) * 100
    const after = before - discountMinor
    const lines = [
      ...(quote['lines'] as Array<Record<string, unknown>>),
      { label: `${reached.percent}% off ${reached.minDays}+ days`, amountMinor: -discountMinor },
    ]

    await tx(`update quotes set state = 'superseded', updated_at = now() where id = $1`, [input.quoteId])
    const [created] = await tx(
      `insert into quotes (
         operator_id, conversation_id, enquiry_id, vehicle_id, revision, state,
         currency, total_minor, deposit_minor, lines, start_date, end_date, days,
         rate_id, valid_until, discount_minor, discount_reason,
         approved_by_membership_id, approved_at
       )
       select operator_id, conversation_id, enquiry_id, vehicle_id,
              (select coalesce(max(revision), 0) + 1 from quotes
                where conversation_id = q.conversation_id and operator_id = q.operator_id),
              -- Approved under whoever set the standing offer: the rule was
              -- their decision, made ahead of time.
              'approved', currency, $3, deposit_minor, $4::jsonb,
              start_date, end_date, days, rate_id, valid_until, $5, $6, $7, now()
       from quotes q where q.id = $1 and q.operator_id = $2
       returning id`,
      [
        input.quoteId, input.operatorId, after, JSON.stringify(lines), discountMinor,
        `Standing offer: ${reached.percent}% off rentals of ${reached.minDays}+ days`,
        quote['discount_tiers_set_by_membership_id'],
      ],
    )
    return {
      ok: true as const,
      quoteId: created!['id'] as string,
      percent: reached.percent,
      minDays: reached.minDays,
      currency: quote['currency'] as string,
      totalMinor: after,
      discountMinor,
      depositMinor: quote['deposit_minor'] == null ? null : Number(quote['deposit_minor']),
    }
  })
}

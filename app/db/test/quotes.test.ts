import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  approveQuote, calculateDraftQuote, discountQuote, formatMoney, listDraftQuotes, listRates,
  renderQuoteMessage, setVehicleHighlight, setVehicleRate,
} from '../src/queries/quotes.ts'
import type { QueryRunner, Transactor } from '../src/runner.ts'

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations')
const OP = '11111111-1111-1111-1111-111111111111'
const ACCOUNT = '33333333-3333-3333-3333-333333333333'
const SARA = '44444444-4444-4444-4444-444444444444'
const CONTACT = '55555555-5555-5555-5555-555555555555'
const CONV = '66666666-6666-6666-6666-666666666666'

let db: PGlite
let run: QueryRunner
let transact: Transactor
let vehicleId: string

async function setRate(fields: Record<string, number | null> = {}) {
  await run(`update vehicle_rates set effective_to = now() where vehicle_id = $1 and effective_to is null`, [vehicleId])
  await run(
    `insert into vehicle_rates (operator_id, vehicle_id, daily_rate_minor, weekly_rate_minor,
                                monthly_rate_minor, minimum_days, deposit_minor, delivery_fee_minor,
                                provenance, confirmed_by, confirmed_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,'operator_confirmed','Owner',now())`,
    [OP, vehicleId,
     fields['daily'] ?? 150000, fields['weekly'] ?? null, fields['monthly'] ?? null,
     fields['minimumDays'] ?? 1, fields['deposit'] ?? 500000, fields['delivery'] ?? null],
  )
}

beforeEach(async () => {
  db = await PGlite.create()
  run = async (t, p) => (await db.query(t, p)).rows as Array<Record<string, unknown>>
  transact = async (fn) => {
    let out: unknown
    await db.transaction(async (tx) => {
      out = await fn(async (text, params) => (await tx.query(text, params)).rows as Array<Record<string, unknown>>)
    })
    return out as never
  }
  for (const f of readdirSync(migrationsDir).filter((n) => n.endsWith('.sql')).sort()) {
    await db.exec(readFileSync(join(migrationsDir, f), 'utf8'))
  }
  await db.exec(`
    insert into operators (id, name, timezone) values ('${OP}', 'Vyra Pilot', 'Asia/Dubai');
    insert into whatsapp_accounts (id, operator_id, provider_account_id, phone_number_id)
    values ('${ACCOUNT}', '${OP}', 'waba', '111');
    insert into memberships (id, operator_id, user_id, role)
    values ('${SARA}', '${OP}', '10000000-0000-0000-0000-000000000001', 'manager');
    insert into contacts (id, operator_id, channel_identifier, display_name)
    values ('${CONTACT}', '${OP}', '971500000001', 'Layla');
    insert into conversations (id, operator_id, contact_id, whatsapp_account_id)
    values ('${CONV}', '${OP}', '${CONTACT}', '${ACCOUNT}');
  `)
  const [v] = await run(
    `insert into vehicles (operator_id, make, model, year, colour, category, plate,
                           chassis_number, provenance, confirmed_by)
     values ($1,'Ferrari','488',2022,'Giallo','exotic','Dubai K 1','VIN1',
             'operator_confirmed','Owner') returning id`,
    [OP],
  )
  vehicleId = v!['id'] as string
})

const quote = (start = '2026-09-20', end = '2026-09-23', duration?: string) =>
  calculateDraftQuote(run, {
    operatorId: OP, conversationId: CONV, enquiryId: null, vehicleId, startDate: start, endDate: end,
    ...(duration === undefined ? {} : { duration }),
  })

describe('the calculation', () => {
  it('is integer fils end to end', async () => {
    await setRate({ daily: 150000 })
    const result = await quote()
    expect(result).toMatchObject({ ok: true })
    if (!result.ok) return
    // 3 days x AED 1,500. No float anywhere in the path.
    expect(result.quote.totalMinor).toBe(450000)
    expect(Number.isInteger(result.quote.totalMinor)).toBe(true)
    expect(formatMoney(result.quote.totalMinor, 'AED')).toBe('AED 4,500')
  })

  /** Whole weeks at the operator's own weekly rate, remainder daily. */
  it('uses the operator tier rather than the arithmetic that suits', async () => {
    await setRate({ daily: 150000, weekly: 800000 })
    const result = await quote('2026-09-01', '2026-09-10')
    if (!result.ok) throw new Error('expected a quote')
    // 9 days = one week (800000) + two days (300000).
    expect(result.quote.totalMinor).toBe(1100000)
    expect(result.quote.lines.map((l) => l.label)).toEqual(['1 week', '2 days'])
  })

  it('adds delivery when the operator charges for it', async () => {
    await setRate({ daily: 100000, delivery: 30000 })
    const result = await quote('2026-09-20', '2026-09-22')
    if (!result.ok) throw new Error('expected a quote')
    expect(result.quote.totalMinor).toBe(230000)
  })

  it('will not price a vehicle with no confirmed rate', async () => {
    const result = await quote()
    expect(result).toMatchObject({ ok: false, refusal: { reason: 'no_confirmed_rate' } })
  })

  /** A rate nobody at the operator stood behind is not a rate. */
  it('ignores a placeholder rate', async () => {
    await run(
      `insert into vehicle_rates (operator_id, vehicle_id, daily_rate_minor, provenance)
       values ($1,$2,999999,'placeholder')`,
      [OP, vehicleId],
    )
    expect(await quote()).toMatchObject({ ok: false, refusal: { reason: 'no_confirmed_rate' } })
  })

  it('refuses below the minimum rental', async () => {
    await setRate({ minimumDays: 7 })
    expect(await quote('2026-09-20', '2026-09-22')).toMatchObject({
      ok: false, refusal: { reason: 'below_minimum_days' },
    })
  })

  /**
   * The live failure: a customer with a 19th-to-21st rental on file said "20th"
   * and then "2". The new start date superseded the old one; end_at and
   * duration did not, because nothing had changed about them — they were facts
   * about a rental that no longer existed. 20th plus a stale 21st is one day,
   * and the customer was quoted AED 5,000 for half of what they had asked for,
   * with "2 days" sitting live on the same enquiry saying otherwise.
   */
  describe('when the dates and the duration disagree', () => {
    it('refuses rather than pricing one of them', async () => {
      await setRate({ daily: 500000 })
      expect(await quote('2026-09-20', '2026-09-21', '2 days')).toMatchObject({
        ok: false, refusal: { reason: 'dates_disagree' },
      })
    })

    /** The model has to be able to turn it into the question a person would ask. */
    it('says what disagrees with what', async () => {
      await setRate({ daily: 500000 })
      const result = await quote('2026-09-20', '2026-09-21', '2 days')
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.refusal.detail).toContain('1 day')
      expect(result.refusal.detail).toContain('2 days')
    })

    it('prices normally when they agree', async () => {
      await setRate({ daily: 500000 })
      expect(await quote('2026-09-20', '2026-09-22', '2 days')).toMatchObject({ ok: true })
    })

    it('is unbothered by an enquiry with no duration on file', async () => {
      await setRate({ daily: 500000 })
      expect(await quote('2026-09-20', '2026-09-22')).toMatchObject({ ok: true })
    })

    /**
     * Weeks and months need a calendar rather than a multiplication, and a
     * wrong guess here would block a correct quote rather than catch a wrong
     * one. So anything that is not a plain count of days is not checked.
     */
    it.each(['a week', '2 weeks', 'one month', 'the weekend', ''])(
      'does not try to read %j', async (duration) => {
        await setRate({ daily: 500000 })
        expect(await quote('2026-09-20', '2026-09-22', duration)).toMatchObject({ ok: true })
      },
    )

    it('reads nights as days, which is how people say it', async () => {
      await setRate({ daily: 500000 })
      expect(await quote('2026-09-20', '2026-09-21', '2 nights')).toMatchObject({
        ok: false, refusal: { reason: 'dates_disagree' },
      })
    })
  })
})

describe('revisions', () => {
  it('supersedes the previous draft rather than editing it', async () => {
    await setRate({ daily: 150000 })
    const first = await quote()
    await setRate({ daily: 200000 })
    const second = await quote()

    if (!first.ok || !second.ok) throw new Error('expected quotes')
    expect(second.quote.revision).toBe(2)

    const rows = await run(
      `select revision, state::text as state, total_minor from quotes order by revision`, [],
    )
    // Both rows survive: "you quoted me 4,500" is a question about revision 1.
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ revision: 1, state: 'superseded', total_minor: 450000 })
    expect(rows[1]).toMatchObject({ revision: 2, state: 'draft', total_minor: 600000 })
  })

  it('leaves exactly one draft', async () => {
    await setRate()
    await quote()
    await quote()
    expect(await listDraftQuotes(run, OP)).toHaveLength(1)
  })
})

describe('approval', () => {
  it('binds to the revision the approver read', async () => {
    await setRate()
    const drafted = await quote()
    if (!drafted.ok) throw new Error('expected a quote')

    const result = await approveQuote(run, {
      quoteId: drafted.quote.quoteId, operatorId: OP, membershipId: SARA,
      revision: drafted.quote.revision,
    })
    expect(result).toMatchObject({ approved: true })
  })

  /**
   * The failure this prevents: a quote revised between somebody reading it and
   * clicking approve.
   */
  it('refuses when the revision moved under the approver', async () => {
    await setRate()
    const first = await quote()
    if (!first.ok) throw new Error('expected a quote')

    await setRate({ daily: 999000 })
    await quote()

    const result = await approveQuote(run, {
      quoteId: first.quote.quoteId, operatorId: OP, membershipId: SARA, revision: 1,
    })
    expect(result).toMatchObject({ approved: false })
  })

  it('refuses an expired draft', async () => {
    await setRate()
    const drafted = await quote()
    if (!drafted.ok) throw new Error('expected a quote')
    await run(`update quotes set valid_until = now() - interval '1 hour' where id = $1`,
              [drafted.quote.quoteId])

    expect(await approveQuote(run, {
      quoteId: drafted.quote.quoteId, operatorId: OP, membershipId: SARA, revision: 1,
    })).toMatchObject({ approved: false, reason: 'expired' })
  })

  /** An approved quote without an approver is money nobody owns. */
  it('cannot be approved without attribution', async () => {
    await setRate()
    const drafted = await quote()
    if (!drafted.ok) throw new Error('expected a quote')
    await expect(
      run(`update quotes set state = 'approved' where id = $1`, [drafted.quote.quoteId]),
    ).rejects.toThrow(/quotes_approval_is_attributed/)
  })

  it('is invisible to another operator', async () => {
    await setRate()
    const drafted = await quote()
    if (!drafted.ok) throw new Error('expected a quote')
    expect(await approveQuote(run, {
      quoteId: drafted.quote.quoteId, operatorId: '22222222-2222-2222-2222-222222222222',
      membershipId: SARA, revision: 1,
    })).toMatchObject({ approved: false, reason: 'not_found' })
  })
})

describe('entering a rate', () => {
  it('supersedes the old one instead of editing it', async () => {
    await setVehicleRate(run, {
      operatorId: OP, vehicleId, confirmedBy: 'sara@example.com', dailyRateMinor: 150000,
    })
    await setVehicleRate(run, {
      operatorId: OP, vehicleId, confirmedBy: 'sara@example.com', dailyRateMinor: 200000,
    })

    const rows = await run(
      `select daily_rate_minor, effective_to from vehicle_rates order by created_at`, [],
    )
    expect(rows).toHaveLength(2)
    // The old rate keeps its window, so a quote raised last week is still
    // explainable by the price that was in force when it was raised.
    expect(rows[0]!['effective_to']).not.toBeNull()
    expect(rows[1]).toMatchObject({ daily_rate_minor: 200000, effective_to: null })
  })

  /** A rate with no name against it is exactly what provenance exists to stop. */
  it('cannot be confirmed without attribution', async () => {
    await expect(
      run(
        `insert into vehicle_rates (operator_id, vehicle_id, daily_rate_minor, provenance)
         values ($1, $2, 150000, 'operator_confirmed')`,
        [OP, vehicleId],
      ),
    ).rejects.toThrow(/vehicle_rates_confirmed_is_attributed/)
  })

  /** A vehicle with no rate must be visible, not absent. */
  it('lists a vehicle that has no rate', async () => {
    const [row] = await listRates(run, OP)
    expect(row).toMatchObject({ vehicleLabel: 'Ferrari 488 · Giallo', dailyRateMinor: null })

    await setVehicleRate(run, {
      operatorId: OP, vehicleId, confirmedBy: 'sara@example.com',
      dailyRateMinor: 150000, depositMinor: 500000,
    })
    const [priced] = await listRates(run, OP)
    expect(priced).toMatchObject({ dailyRateMinor: 150000, depositMinor: 500000 })
  })
})

describe('the message a customer reads', () => {
  it('renders the stored figures, not a model phrasing them', async () => {
    await setRate({ daily: 150000, deposit: 500000 })
    const drafted = await quote()
    if (!drafted.ok) throw new Error('expected a quote')

    const message = renderQuoteMessage({
      currency: drafted.quote.currency,
      lines: drafted.quote.lines,
      totalMinor: drafted.quote.totalMinor,
      depositMinor: drafted.quote.depositMinor,
      days: drafted.quote.days,
      validUntil: drafted.quote.validUntil,
    })

    /**
     * One line and a total that repeats it is the same number twice, which
     * reads as a system padding rather than as a quote. Live, a nineteen-day
     * rental went out exactly that way.
     */
    expect(message).toContain('*3 days: AED 4,500*')
    expect(message).not.toContain('Total: AED 4,500')
    expect(message).toContain('Refundable deposit: AED 5,000')
    // A price with no end is a promise with no end — and written the way a
    // person writes a date, not as the ISO string that reached a customer.
    expect(message).toContain('Valid until')
    expect(message).not.toMatch(/\d{4}-\d{2}-\d{2}/)
  })

  /** Several lines, and the total is then telling them something new. */
  it('totals the lines when there is more than one', () => {
    const message = renderQuoteMessage({
      currency: 'AED',
      lines: [
        { label: '3 days', amountMinor: 450000 },
        { label: 'Delivery', amountMinor: 50000 },
      ],
      totalMinor: 500000,
      depositMinor: null,
      days: 3,
      validUntil: null,
    })

    expect(message).toContain('3 days: AED 4,500')
    expect(message).toContain('Delivery: AED 500')
    expect(message).toContain('*Total: AED 5,000*')
  })

  it('formats fils that are not whole currency', () => {
    expect(formatMoney(150050, 'AED')).toBe('AED 1,500.50')
  })
})

/**
 * A few words the operator wants beside a car.
 *
 * Set by a person rather than computed. "Best seller" is a factual claim about
 * the business, and counting bookings early means "the one we photographed" —
 * a number we invented, in the operator's voice.
 */
describe('setting what is said about a car', () => {
  const vehicle = async () =>
    (await run(`select id from vehicles limit 1`, []))[0]!['id'] as string

  it('is stored and comes back with the rate', async () => {
    const id = await vehicle()
    expect(await setVehicleHighlight(run, {
      operatorId: OP, vehicleId: id, highlight: 'Best seller',
      actorMembershipId: SARA,
    })).toEqual({ changed: true })

    const rates = await listRates(run, OP)
    expect(rates.find((r) => r.vehicleId === id)!.highlight).toBe('Best seller')
  })

  it('is capped rather than allowed to eat the rest of the row', async () => {
    const id = await vehicle()
    await setVehicleHighlight(run, {
      operatorId: OP, vehicleId: id,
      highlight: 'The one everybody in Dubai asks us about',
      actorMembershipId: SARA,
    })

    const [row] = await run(`select highlight from vehicles where id = $1`, [id])
    expect((row!['highlight'] as string).length).toBeLessThanOrEqual(18)
  })

  it.each(['', '   '])('treats %j as clearing it', async (highlight) => {
    const id = await vehicle()
    await setVehicleHighlight(run, {
      operatorId: OP, vehicleId: id, highlight: 'Best seller',
      actorMembershipId: SARA,
    })
    await setVehicleHighlight(run, {
      operatorId: OP, vehicleId: id, highlight, actorMembershipId: SARA,
    })

    const [row] = await run(`select highlight from vehicles where id = $1`, [id])
    expect(row!['highlight']).toBeNull()
  })

  /** Customers read it in the operator's voice, so who said it is worth keeping. */
  it('records who said it', async () => {
    const id = await vehicle()
    await setVehicleHighlight(run, {
      operatorId: OP, vehicleId: id, highlight: 'Best seller',
      actorMembershipId: SARA,
    })

    const [event] = await run(
      `select actor_id, data from audit_events where action = 'vehicle.highlight_set'`, [],
    )
    expect(event!['actor_id']).toBe(SARA)
    expect((event!['data'] as Record<string, unknown>)['highlight']).toBe('Best seller')
  })

  it('refuses a car belonging to somebody else', async () => {
    const id = await vehicle()
    expect(await setVehicleHighlight(run, {
      operatorId: '99999999-9999-9999-9999-999999999999', vehicleId: id,
      highlight: 'Best seller', actorMembershipId: SARA,
    })).toEqual({ changed: false })
  })
})

/**
 * Taking something off the price, which could not be done at all.
 *
 * calculateDraftQuote has no discount input by design — section 18.7 calls a
 * discount a manager's approval rather than a calculation — and approving
 * sends the exact figures. So the only way to give one was to type it into a
 * message, and the record then said one thing while the customer held another.
 * Survivable while a quote was a number in a chat; not survivable once a
 * booking confirms against a quote id, because the customer agrees to 9,500
 * and the booking holds them to 10,000.
 */
describe('discounting a quote', () => {
  const draft = async () => {
    await setRate()
    const result = await calculateDraftQuote(run, {
      operatorId: OP, conversationId: CONV, enquiryId: null, vehicleId,
      startDate: '2026-09-25', endDate: '2026-09-27', duration: null,
    })
    if (!result.ok) throw new Error('fixture could not be priced: ' + result.refusal.reason)
    return result.quote
  }

  const take = (q: { quoteId: string; revision: number }, off: number, reason = 'returning customer') =>
    discountQuote(transact, {
      operatorId: OP, quoteId: q.quoteId, membershipId: SARA,
      revision: q.revision, discountMinor: off, reason,
    })

  it('produces a new revision at the lower price', async () => {
    const q = await draft()
    const result = await take(q, 50_000)

    expect(result).toMatchObject({ ok: true, totalMinor: q.totalMinor - 50_000 })
    expect((result as { revision: number }).revision).toBeGreaterThan(q.revision)
  })

  /** "What was I quoted before the discount" stays answerable. */
  it('supersedes the original rather than overwriting it', async () => {
    const q = await draft()
    await take(q, 50_000)

    const [old] = await run(
      `select state::text as state, total_minor from quotes where id = $1`, [q.quoteId])
    expect(old).toMatchObject({ state: 'superseded', total_minor: q.totalMinor })
  })

  it('carries who gave it and why, and the why never reaches the customer', async () => {
    const q = await draft()
    const result = await take(q, 50_000, 'third rental this year')

    const [row] = await run(
      `select discount_minor, discount_reason, approved_by_membership_id, approved_at, state::text as state
       from quotes where id = $1`, [(result as { quoteId: string }).quoteId])
    expect(row).toMatchObject({
      discount_minor: 50_000,
      discount_reason: 'third rental this year',
      approved_by_membership_id: SARA,
      // Approved in the same act: setting a discount is the approval.
      state: 'approved',
    })
    expect(row!['approved_at']).not.toBeNull()
  })

  it('shows the reduction as its own line', async () => {
    const q = await draft()
    const result = await take(q, 50_000)
    const [row] = await run(
      `select lines from quotes where id = $1`, [(result as { quoteId: string }).quoteId])
    const lines = row!['lines'] as Array<Record<string, unknown>>
    expect(lines.at(-1)).toMatchObject({ label: 'Discount', amountMinor: -50_000 })
  })

  it('records it against the person in the audit trail', async () => {
    const q = await draft()
    await take(q, 50_000)
    const [event] = await run(
      `select actor_id, data from audit_events where action = 'quote.discounted'`, [])
    expect(event!['actor_id']).toBe(SARA)
    expect((event!['data'] as Record<string, unknown>)['discount_minor']).toBe(50_000)
  })

  /** A discount takes something off a price; it cannot make one. */
  it('refuses more than the total', async () => {
    const q = await draft()
    expect(await take(q, q.totalMinor)).toMatchObject({ ok: false, reason: 'too_large' })
    expect(await take(q, -100)).toMatchObject({ ok: false, reason: 'too_large' })
  })

  /** The same guard as approving: numbers nobody read cannot be sent. */
  it('refuses when the quote was repriced while the page was open', async () => {
    const q = await draft()
    expect(await discountQuote(transact, {
      operatorId: OP, quoteId: q.quoteId, membershipId: SARA,
      revision: q.revision + 1, discountMinor: 50_000, reason: 'x',
    })).toMatchObject({ ok: false, reason: 'revision_moved' })
  })

  /**
   * Two people being generous about the same rental. The second takes its cut
   * off what is now owed, not off the list price.
   */
  it('discounts a discounted quote from the new total', async () => {
    const q = await draft()
    const once = await take(q, 50_000) as { quoteId: string; revision: number; totalMinor: number }
    const twice = await take(once, 25_000)

    expect(twice).toMatchObject({ ok: true, totalMinor: once.totalMinor - 25_000 })
    const [row] = await run(
      `select discount_minor from quotes where id = $1`, [(twice as { quoteId: string }).quoteId])
    // And the record knows the whole of what was given away, not just the last bite.
    expect(row!['discount_minor']).toBe(75_000)
  })
})

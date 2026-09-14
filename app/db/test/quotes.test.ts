import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  approveQuote, calculateDraftQuote, formatMoney, listDraftQuotes,
} from '../src/queries/quotes.ts'
import type { QueryRunner } from '../src/runner.ts'

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations')
const OP = '11111111-1111-1111-1111-111111111111'
const ACCOUNT = '33333333-3333-3333-3333-333333333333'
const SARA = '44444444-4444-4444-4444-444444444444'
const CONTACT = '55555555-5555-5555-5555-555555555555'
const CONV = '66666666-6666-6666-6666-666666666666'

let db: PGlite
let run: QueryRunner
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

const quote = (start = '2026-09-20', end = '2026-09-23') =>
  calculateDraftQuote(run, {
    operatorId: OP, conversationId: CONV, enquiryId: null, vehicleId, startDate: start, endDate: end,
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

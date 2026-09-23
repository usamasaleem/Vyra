import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { draftKnowledge, publishKnowledge, type QueryRunner, type Transactor } from '@vyra/db'

/**
 * A copy of the pilot operator, in memory, for customers who do not exist.
 *
 * The same fleet, rates and deposits as production, the same published answers,
 * and the same switches — auto-confirm on, calendar vouched for, a two-hour
 * hold. Nothing here touches the real database: a simulated Ferrari booking
 * must never hold the real Ferrari.
 *
 * `withAnswers` adds the two answers the pilot has not written yet (how to pay,
 * where to collect), so a run can show the flow as it is today and as it will
 * be once they are published.
 */
export const OPERATOR = '11111111-1111-1111-1111-111111111111'
const ACCOUNT = '33333333-3333-3333-3333-333333333333'
const MEMBER = '88888888-8888-8888-8888-888888888888'

export type SimWorld = {
  run: QueryRunner
  transact: Transactor
  vehicles: Record<'ferrari' | 'huracan' | 'cullinan', string>
  close: () => Promise<void>
}

const FLEET = [
  {
    key: 'ferrari', make: 'Ferrari', model: '488', variant: 'Spider', year: 2022,
    colour: 'Giallo Modena (yellow)', category: 'exotic', engine: '3.9 L twin-turbo V8', hp: 661,
    seats: 2, doors: 2, rate: 500_000, deposit: 500_000,
    photos: ['https://cdn.mkrentacar.com/wp-content/uploads/2025/04/2-1.png'],
  },
  {
    key: 'huracan', make: 'Lamborghini', model: 'Huracán', variant: 'Tecnica', year: 2023,
    colour: 'Verde (green)', category: 'exotic', engine: '5.2 L naturally aspirated V10', hp: 631,
    seats: 2, doors: 2, rate: 550_000, deposit: 550_000,
    photos: ['https://cdn.mkrentacar.com/wp-content/uploads/2025/04/lamborghini-06.jpg'],
  },
  {
    key: 'cullinan', make: 'Rolls-Royce', model: 'Cullinan', variant: null, year: 2024,
    colour: 'English White', category: 'suv', engine: '6.75 L twin-turbo V12', hp: 571,
    seats: 5, doors: 4, rate: 800_000, deposit: 800_000,
    photos: ['https://cdn.mkrentacar.com/wp-content/uploads/2025/04/c6nm9f3dds.jpg'],
  },
] as const

/** Production's published answers, word for word. */
const PUBLISHED: Record<string, string> = {
  'driver-requirements-resident':
    'You will need your Emirates ID and your UAE driving licence, both in the driver’s own name. '
    + 'The minimum age is 25 and the licence must have been held for at least a year. The security '
    + 'deposit is taken on a credit card in the same name — the amount depends on the car and is '
    + 'quoted with the price.',
  'driver-requirements-visitor':
    'You will need your passport, a valid visit visa or entry stamp, and your driving licence from '
    + 'home. Licences from the GCC, UK, EU, US, Canada, Australia, New Zealand, Japan and South Korea '
    + 'are accepted on their own if they are in English or Arabic; otherwise bring an International '
    + 'Driving Permit alongside your licence. The minimum age is 25 and you must have held your '
    + 'licence for at least a year. The security deposit is taken on a credit card in the driver’s '
    + 'own name — the amount depends on the car and is quoted with the price.',
  'follow-up-message':
    'Still thinking it over? Happy to answer anything about the car or the dates whenever you are ready.',
  'follow-up-message-2':
    'No rush at all. I will leave it with you — just say the word if you would like me to pick it back up.',
  greeting:
    'Thanks for getting in touch with Vyra Pilot. Happy to help with anything about the cars — just '
    + 'say what you are looking for and when.',
}

/** What the pilot has not written yet. Test data only — this account does not exist. */
const NOT_YET_PUBLISHED: Record<string, string> = {
  payment:
    'You can pay by bank transfer to Vyra Pilot LLC, Emirates NBD (IBAN AE07 0331 2345 6789 0123 456), '
    + 'by the payment link we send you, or by card or cash when the car is handed over. For a '
    + 'transfer, please send a screenshot once it is done so we can match it.',
  'included-kilometres':
    '250 km a day are included. Beyond that it is AED 5 per extra kilometre, charged when the car comes back.',
  'delivery-areas':
    'We deliver anywhere in Dubai for free, and collect from the same place at the end. Sharjah and Abu '
    + 'Dhabi are AED 300 each way. The car may be driven anywhere in the UAE, but not across the border.',
  'collection-point':
    'Collect the car from our showroom at Al Quoz Industrial 3, Street 17 (pin: maps.app.goo.gl/vyra). '
    + 'Please message us here when you are 10 minutes away so the car is ready.',
}

export async function createSimWorld(options: { withAnswers: boolean }): Promise<SimWorld> {
  const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'db', 'migrations')
  const db = await PGlite.create()
  const run: QueryRunner = async (text, params) =>
    (await db.query(text, params as unknown[])).rows as Array<Record<string, unknown>>
  const transact: Transactor = async (fn) => {
    let out: unknown
    await db.transaction(async (tx) => {
      out = await fn(async (text, params) =>
        (await tx.query(text, params as unknown[])).rows as Array<Record<string, unknown>>)
    })
    return out as never
  }

  for (const f of readdirSync(migrationsDir).filter((n) => n.endsWith('.sql')).sort()) {
    await db.exec(readFileSync(join(migrationsDir, f), 'utf8'))
  }
  await db.exec(`
    insert into operators (id, name, timezone, availability_calendar_complete, auto_confirm_bookings,
                           hold_minutes, follow_up_after_minutes, ai_sending_enabled)
    values ('${OPERATOR}', 'Vyra Pilot', 'Asia/Dubai', true, true, 120, 60, true);
    insert into whatsapp_accounts (id, operator_id, provider_account_id, phone_number_id)
    values ('${ACCOUNT}', '${OPERATOR}', 'waba-sim', '111');
    insert into memberships (id, operator_id, user_id, role, display_name)
    values ('${MEMBER}', '${OPERATOR}', '99999999-9999-9999-9999-999999999999', 'admin', 'Usama');
  `)

  const vehicles = {} as SimWorld['vehicles']
  for (const v of FLEET) {
    const [row] = await run(
      `insert into vehicles (operator_id, make, model, variant, year, colour, category, plate,
                            chassis_number, engine, power_hp, seats, doors, active, provenance,
                            confirmed_by, confirmed_at, photo_urls)
       values ($1,$2,$3,$4,$5,$6,$7::vehicle_category,$8,$9,$10,$11,$12,$13,true,'operator_confirmed',
               'Simulation', now(), $14::jsonb)
       returning id`,
      [OPERATOR, v.make, v.model, v.variant, v.year, v.colour, v.category, `SIM ${v.key}`,
        `SIM-${v.key}`, v.engine, v.hp, v.seats, v.doors, JSON.stringify(v.photos)],
    )
    vehicles[v.key] = row!['id'] as string
    await run(
      `insert into vehicle_rates (operator_id, vehicle_id, currency, daily_rate_minor, deposit_minor,
                                  minimum_days, provenance, confirmed_by, confirmed_at)
       values ($1, $2, 'AED', $3, $4, 1, 'operator_confirmed', 'Simulation', now())`,
      [OPERATOR, vehicles[v.key], v.rate, v.deposit],
    )
  }

  const answers = options.withAnswers ? { ...PUBLISHED, ...NOT_YET_PUBLISHED } : PUBLISHED
  for (const [topic, answer] of Object.entries(answers)) {
    const draft = await draftKnowledge(run, {
      operatorId: OPERATOR, topic, answer, confirmedBy: 'Simulation', confirmedByMembershipId: MEMBER,
    })
    await publishKnowledge(transact, { operatorId: OPERATOR, entryId: draft.id, membershipId: MEMBER })
    await run(`update knowledge_entries set effective_from = now() - interval '1 day' where id = $1`, [draft.id])
  }

  return { run, transact, vehicles, close: () => db.close() }
}

let seq = 0

/** A new customer, with their own contact and conversation. */
export async function newCustomer(world: SimWorld, name: string): Promise<{ conversationId: string }> {
  seq++
  const suffix = String(seq).padStart(12, '0')
  const contactId = `55555555-5555-5555-5555-${suffix}`
  const conversationId = `66666666-6666-6666-6666-${suffix}`
  await world.run(
    `insert into contacts (id, operator_id, channel_identifier, display_name) values ($1, $2, $3, $4)`,
    [contactId, OPERATOR, `97150${suffix.slice(-7)}`, name],
  )
  await world.run(
    `insert into conversations (id, operator_id, contact_id, whatsapp_account_id)
     values ($1, $2, $3, $4)`,
    [conversationId, OPERATOR, contactId, ACCOUNT],
  )
  return { conversationId }
}

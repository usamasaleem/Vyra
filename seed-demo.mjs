/**
 * Publishes the invented placeholder answers as demo content.
 *
 * Every figure below is invented — see the banner in
 * app/evals/src/fixtures/placeholder-policy.ts. They are published here so the
 * agent can be demonstrated answering instead of deferring, and they are signed
 * with a confirmer name that makes their status unmistakable on the Answers
 * screen and in any audit of what the business told a customer.
 *
 * `node seed-demo.mjs --clear` removes them again.
 */
import postgres from 'postgres'
import { readFileSync } from 'node:fs'

const CONFIRMER = 'DEMO DATA — not confirmed by an operator'

const ANSWERS = {
  deposit: 'A refundable security deposit is held on a credit card for the rental period: AED 5,000 for luxury vehicles and AED 15,000 for exotic vehicles. It is released within 14 working days of return, after Salik and any fines are settled.',
  'included-kilometres': '250 km per day are included. Additional kilometres are charged at AED 10 per km for luxury vehicles and AED 25 per km for exotic vehicles.',
  'driver-requirements-resident': 'UAE residents need a valid UAE driving licence, Emirates ID, and a credit card in the driver’s own name. Minimum age is 23 for luxury vehicles and 25 for exotic vehicles.',
  'driver-requirements-visitor': 'Visitors need their passport, UAE entry stamp or visa, a licence from their home country together with an International Driving Permit, and a credit card in the driver’s own name. Minimum age is 23 for luxury vehicles and 25 for exotic vehicles.',
  'delivery-areas': 'Delivery and collection anywhere in Dubai is complimentary. Abu Dhabi and Sharjah are AED 300 each way. Other emirates are arranged case by case. Cross-emirate travel during the rental is permitted and must be mentioned when booking.',
  'business-hours': 'The showroom is open 09:00–21:00 Sunday to Thursday and 10:00–22:00 Friday and Saturday, Dubai time. Messages received outside those hours are answered when the team is next in, usually first thing in the morning.',
  'follow-up-timing': 'Follow up once after ten minutes if the customer has not replied, then twice more at widening gaps, all within the day. Stop after that unless the customer responds.',
  // The message itself, sent word for word. Kept separate from the rule above
  // because the rule is a note to the team and this is a sentence a customer
  // reads — and for a while the sending code used the rule as the message.
  'follow-up-message': 'Still thinking about those dates? Happy to hold the car for you if it helps.',
}

const env = Object.fromEntries(
  readFileSync('app/inbox/.env.local', 'utf8').split('\n').filter((l) => l.includes('='))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).replace(/^["']|["']$/g, '')]))
const sql = postgres(env.DATABASE_URL, { prepare: false })

const [operator] = await sql`select id, name from operators order by created_at limit 1`
if (operator === undefined) { console.error('No operator.'); process.exit(1) }

/**
 * Photographs, for testing the image path end to end.
 *
 * Only the Huracán. The repository's other car image is an SF90, which is not
 * the 488 Spider in this fleet, and a photograph of a different model is the
 * same class of untruth as an invented price — the exact thing findVehiclePhoto
 * refuses to do when it cannot tell two cars apart. Leaving the other two
 * without a picture also proves the fallback: a car with no photograph still
 * answers, in words.
 *
 * Served from the operator's own dashboard site, which is where real photos
 * come from in production too: the operator's website, not a store we build.
 */
const PHOTOS = {
  'Huracán': ['https://veyraagent.netlify.app/assets/lamborghini-huracan.png'],
}

if (process.argv.includes('--clear')) {
  // Only ever the demo rows. A real answer confirmed by a person is untouched.
  const gone = await sql`delete from knowledge_entries
    where operator_id = ${operator.id} and confirmed_by = ${CONFIRMER} returning topic`
  console.log(`Removed ${gone.length} demo answer(s).`)

  for (const url of Object.values(PHOTOS).flat()) {
    const cleared = await sql`update vehicles set photo_urls = null, collage_url = null
      where operator_id = ${operator.id} and photo_urls::text like ${'%' + url + '%'}
      returning model`
    if (cleared.length > 0) console.log(`Removed demo photo from ${cleared.length} vehicle(s).`)
  }
  await sql.end()
  process.exit(0)
}

for (const [topic, answer] of Object.entries(ANSWERS)) {
  // Refuse to overwrite anything a real person confirmed.
  const [real] = await sql`select confirmed_by from knowledge_entries
    where operator_id = ${operator.id} and topic = ${topic}
      and published_at is not null and effective_to is null
      and confirmed_by <> ${CONFIRMER} limit 1`
  if (real !== undefined) {
    console.log(`SKIP ${topic} — already answered by ${real.confirmed_by}`)
    continue
  }

  await sql`update knowledge_entries set effective_to = now()
    where operator_id = ${operator.id} and topic = ${topic} and effective_to is null`

  const [{ next }] = await sql`select coalesce(max(version), 0) + 1 as next
    from knowledge_entries where operator_id = ${operator.id} and topic = ${topic}`

  await sql`insert into knowledge_entries
    (operator_id, topic, covers, answer, version, provenance, confirmed_by, confirmed_at,
     published_at, effective_from)
    values (${operator.id}, ${topic}, ${'Demo content for demonstration only'}, ${answer},
            ${next}, 'operator_confirmed', ${CONFIRMER}, now(), now(), now())`
  console.log(`published ${topic} (v${next})`)
}

for (const [model, urls] of Object.entries(PHOTOS)) {
  const [existing] = await sql`select photo_urls from vehicles
    where operator_id = ${operator.id} and model = ${model} and active limit 1`
  if (existing === undefined) { console.log(`SKIP photo for ${model} — no such car`); continue }
  if (existing.photo_urls !== null && !JSON.stringify(existing.photo_urls).includes('veyraagent')) {
    console.log(`SKIP photo for ${model} — already has real photographs`)
    continue
  }
  // sql.json, not JSON.stringify: postgres.js encodes a JS value for a jsonb
  // column itself, so handing it an already-stringified array stores a jsonb
  // *string* containing JSON rather than a jsonb array. That is what broke
  // production — jsonb_array_length raised on it and every turn died.
  // The collage URL is normally written by the inbox, which knows its own host.
  // Seeding bypasses that, so it is named here — two photographs or more,
  // because a collage of one is a photograph.
  const [row] = await sql`select id from vehicles
    where operator_id = ${operator.id} and model = ${model} and active limit 1`
  const collage = urls.length >= 2
    ? `https://vyra-inbox.netlify.app/api/fleet-photo/${row.id}`
    : null

  const done = await sql`update vehicles
    set photo_urls = ${sql.json(urls)}, collage_url = ${collage}, updated_at = now()
    where operator_id = ${operator.id} and model = ${model} and active returning model`
  console.log(`photo set on ${done.length} × ${model}${collage === null ? '' : ' (with collage)'}`)
}

console.log(`\nOperator: ${operator.name}`)
console.log('Every figure above is invented. Clear with: node seed-demo.mjs --clear')
await sql.end()

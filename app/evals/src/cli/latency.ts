import { createEvalWorld, EVAL_NOW } from '../harness/world.js'
import { mightNeedAvailability, mightNeedTheFleet } from '@vyra/contracts'
import { openaiModel, runTurn, searchVehicles, type ServiceTier } from '@vyra/agent'

/**
 * Does Fast mode actually make a reply arrive sooner?
 *
 * The scorecard measures whether an answer is right. This measures how long it
 * took, which is the only question Fast mode raises — it is a queue, not a
 * different model, so the reply should be the same reply.
 *
 * Cost is not the question and the arithmetic says so: gpt-5.6-luna is $0.20
 * per million input and $1.20 output, Fast mode $0.40 and $1.80, and with this
 * product's shape — a long prompt and a two-line reply — that is 1.88x on a
 * per-reply cost of $0.0007. At the pilot's volume the difference is sixty
 * cents a month. So the bar is speed alone: if it does not move p50 well under
 * five seconds it is not worth a dependency on a premium tier.
 *
 * Real messages from the pilot transcripts rather than invented ones, and the
 * same set the reasoning-effort measurement used, so the two are comparable.
 *
 * The fleet is seeded and prefetched here exactly as the worker does it. The
 * first version of this file did neither, which made every number a
 * measurement of an agent with no cars — fine for comparing two service tiers,
 * since both saw the same nothing, and useless for the question of whether the
 * model stops calling search_vehicles when the answer is already in front of
 * it. That question is worth more than the tier one: nineteen of the
 * twenty-four two-round turns in the pilot had the fleet in the prompt and
 * looked it up regardless.
 *
 * Usage:
 *   OPENAI_API_KEY=... npx tsx app/evals/src/cli/latency.ts [rounds]
 */

/** Taken from the live conversation, shortest to longest work. */
const MESSAGES: Array<{ id: string; say: string[] }> = [
  { id: 'greeting', say: ['hi'] },
  { id: 'fleet', say: ['show me your cars'] },
  { id: 'one-car', say: ['show me your cars', 'Ferrari 488, please.'] },
  { id: 'policy', say: ['what is the deposit?'] },
  { id: 'dates', say: ['I want the lambo from the 19th for 2 days, delivered to marina'] },
  { id: 'discount', say: ['can you do 3000 for the weekend?'] },
]

const key = process.env['OPENAI_API_KEY']
if (key === undefined || key === '') {
  console.error('OPENAI_API_KEY is not set, so there is nothing to measure.')
  process.exit(1)
}

const model = process.env['AI_MODEL'] ?? 'gpt-6-luna'
const effort = (process.env['AI_REASONING_EFFORT'] ?? 'low') as 'low'
const rounds = Number(process.argv[2] ?? 3)
/** WITHHOLD=0 measures the other side of the change in the same build. */
const withholding = process.env['WITHHOLD'] !== '0'

/** Standard first each round, so a warming cache cannot flatter Fast mode. */
const TIERS: Array<ServiceTier | undefined> = [undefined, 'fast']

type Sample = { tier: string; caseId: string; ms: number; rounds: number; tools: string[] }
const samples: Sample[] = []

const world = await createEvalWorld()

/**
 * The pilot's own three cars, with their real rates.
 *
 * An empty fleet is not a cheaper version of a real one — it is a different
 * conversation, and the model answers it differently.
 */
await world.run(
  `insert into vehicles (operator_id, make, model, variant, year, colour, category,
                         plate, chassis_number, seats, engine, provenance, confirmed_by)
   values ($1,'Rolls-Royce','Cullinan',null,2023,'English White','suv','D 1','V1',5,
           '6.75 L twin-turbo V12','operator_confirmed','Owner'),
          ($1,'Lamborghini','Huracán','Tecnica',2023,'Verde','exotic','D 2','V2',2,
           '5.2 L V10','operator_confirmed','Owner'),
          ($1,'Ferrari','488','Spider',2022,'Giallo Modena','exotic','D 3','V3',2,
           '3.9 L twin-turbo V8','operator_confirmed','Owner')`,
  [world.operatorId],
)
await world.run(
  `insert into vehicle_rates (operator_id, vehicle_id, currency, daily_rate_minor,
                              confirmed_by, confirmed_at)
   select $1, v.id, 'AED',
          case v.model when 'Cullinan' then 800000 when 'Huracán' then 550000 else 500000 end,
          'Owner', now()
   from vehicles v where v.operator_id = $1`,
  [world.operatorId],
)

for (let round = 1; round <= rounds; round++) {
  for (const tier of TIERS) {
    const adapter = openaiModel({
      apiKey: key, model, effort, ...(tier === undefined ? {} : { serviceTier: tier }),
    })
    for (const message of MESSAGES) {
      const ctx = await world.contextFor(`${message.id}-${tier ?? 'std'}-${round}`, message.say)

      /**
       * The prefetch, as the worker does it — same gate, same all-null filters,
       * same JSON. Deliberately outside the timer: the worker pays for it too,
       * but it is one small query and the question here is model rounds.
       */
      const latest = message.say[message.say.length - 1] ?? ''
      const prefetched = mightNeedTheFleet(latest)
        ? await searchVehicles(ctx, {
            vehicle: null, category: null, maxDayRateMinor: null,
            minSeats: null, order: null, startDate: null, endDate: null,
          }).then((r) => (r.status === 'ok' ? r.data : undefined)).catch(() => undefined)
        : undefined

      const began = Date.now()
      try {
        const outcome = await runTurn(adapter, ctx, message.say.map((text) => ({
          from: 'customer' as const, text,
        })), {
          summary: null,
          ...(prefetched === undefined ? {} : { fleetOnHand: JSON.stringify(prefetched) }),
          // As the worker does it: the fleet is in the prompt, so the lookup
          // is withheld unless availability could be the question.
          ...(withholding && prefetched !== undefined && !mightNeedAvailability(latest)
            ? { withoutTools: ['search_vehicles'] as const }
            : {}),
        })
        samples.push({
          tier: tier ?? 'standard',
          caseId: message.id,
          ms: Date.now() - began,
          rounds: outcome.rounds,
          tools: outcome.toolCalls.map((c) => c.requestedName),
        })
      } catch (error: unknown) {
        console.error(`  ${message.id} ${tier ?? 'standard'} failed:`,
          error instanceof Error ? error.message : String(error))
      }
      process.stdout.write('.')
    }
  }
}
process.stdout.write('\n\n')
await world.close()

const stat = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b)
  return {
    n: sorted.length,
    p50: sorted[Math.floor(sorted.length * 0.5)] ?? 0,
    p90: sorted[Math.floor(sorted.length * 0.9)] ?? 0,
    mean: Math.round(sorted.reduce((a, b) => a + b, 0) / (sorted.length || 1)),
  }
}

console.log(`${model}:${effort} · ${rounds} rounds · prompt ${EVAL_NOW.toISOString().slice(0, 10)}`)
console.log()
console.log(`withholding search_vehicles: ${withholding ? 'yes' : 'no'}`)
console.log('case'.padEnd(12), 'standard'.padStart(10), 'fast'.padStart(10), '2-round'.padStart(10))
for (const message of MESSAGES) {
  const std = stat(samples.filter((s) => s.caseId === message.id && s.tier === 'standard').map((s) => s.ms))
  const fast = stat(samples.filter((s) => s.caseId === message.id && s.tier === 'fast').map((s) => s.ms))
  const twoRound = samples.filter((s) => s.caseId === message.id && s.rounds > 1).length
  const total = samples.filter((s) => s.caseId === message.id).length
  console.log(
    message.id.padEnd(12),
    `${(std.p50 / 1000).toFixed(1)}s`.padStart(10),
    `${(fast.p50 / 1000).toFixed(1)}s`.padStart(10),
    `${twoRound}/${total}`.padStart(10),
  )
}

console.log()
for (const tier of ['standard', 'fast']) {
  const all = samples.filter((s) => s.tier === tier)
  const s = stat(all.map((x) => x.ms))
  const extraRounds = all.filter((x) => x.rounds > 1).length
  console.log(
    `${tier.padEnd(9)} n=${String(s.n).padStart(3)}  p50 ${(s.p50 / 1000).toFixed(1)}s  ` +
    `p90 ${(s.p90 / 1000).toFixed(1)}s  mean ${(s.mean / 1000).toFixed(1)}s  ` +
    `· ${extraRounds}/${s.n} needed a second round`,
  )
}

/**
 * The same tool calls, or it is not the same reply.
 *
 * A tier is a queue and must not change what the model decides. If these
 * diverge, the measurement is of two different things and the speed number
 * means nothing.
 */
console.log()
for (const message of MESSAGES) {
  const of = (tier: string) => [...new Set(samples
    .filter((s) => s.caseId === message.id && s.tier === tier)
    .map((s) => s.tools.join('+') || 'none'))].sort().join(' | ')
  const std = of('standard')
  const fast = of('fast')
  if (std !== fast) console.log(`  DIFFERENT  ${message.id}: standard [${std}] vs fast [${fast}]`)
}

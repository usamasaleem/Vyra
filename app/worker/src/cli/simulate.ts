import { writeFileSync } from 'node:fs'
import { openaiModel } from '@vyra/agent'
import { check, type Finding } from '../simulate/checks.js'
import { PERSONAS } from '../simulate/personas.js'
import { playPersona, type Played } from '../simulate/run.js'

/**
 * Simulated customers, played through the real agent.
 *
 *   npm run simulate --workspace=app/worker
 *   npm run simulate --workspace=app/worker -- --only decisive-visitor,po-box
 *   npm run simulate --workspace=app/worker -- --answers      (payment + collection point published)
 *   npm run simulate --workspace=app/worker -- --out report.md
 *
 * Each customer gets a database of their own, in memory — never production.
 * The agent is the real one, on the real model, so a run costs what that many
 * conversations cost.
 */
const args = process.argv.slice(2)
const flag = (name: string) => {
  const i = args.indexOf(name)
  return i === -1 ? null : (args[i + 1] ?? '')
}
const only = flag('--only')?.split(',').map((s) => s.trim()).filter(Boolean) ?? null
const withAnswers = args.includes('--answers')
const out = flag('--out') ?? `simulation-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.md`
const concurrency = Number(flag('--concurrency') ?? 4)

const apiKey = process.env['OPENAI_API_KEY']
if (apiKey === undefined || apiKey === '') {
  console.error('OPENAI_API_KEY is not set (it is read from app/inbox/.env.local).')
  process.exit(2)
}
const modelName = process.env['AI_MODEL'] ?? 'gpt-5.6-luna'
const effort = process.env['AI_REASONING_EFFORT'] as 'low' | 'medium' | 'high' | undefined
const model = openaiModel({ apiKey, model: modelName, ...(effort === undefined ? {} : { effort }) })

const personas = only === null ? PERSONAS : PERSONAS.filter((p) => only.includes(p.id))
if (personas.length === 0) {
  console.error(`No personas match ${only?.join(', ')}. Known: ${PERSONAS.map((p) => p.id).join(', ')}`)
  process.exit(2)
}

console.log(`Simulating ${personas.length} customer(s) on ${modelName}${withAnswers ? ', with payment and collection answers published' : ''}…`)

const results: Array<{ played: Played; findings: Finding[] }> = []
let next = 0
await Promise.all(Array.from({ length: Math.min(concurrency, personas.length) }, async () => {
  while (next < personas.length) {
    const persona = personas[next++]!
    const played = await playPersona({
      persona, model, customerModel: { apiKey, model: modelName }, withAnswers,
    })
    const findings = check(played)
    results.push({ played, findings })
    const fails = findings.filter((f) => f.severity === 'fail').length
    console.log(`${fails === 0 ? 'PASS' : 'FAIL'}  ${persona.id}${fails === 0 ? '' : `  (${fails} failing)`}`)
  }
}))
results.sort((a, b) => personas.indexOf(a.played.persona) - personas.indexOf(b.played.persona))

// — The report.
const passed = results.filter((r) => r.findings.every((f) => f.severity !== 'fail')).length
const booked = results.filter((r) => r.played.facts.bookings.some((b) => b.state === 'confirmed')).length
const allMs = results.flatMap((r) => r.played.turnMs)
const avg = allMs.length === 0 ? 0 : Math.round(allMs.reduce((a, b) => a + b, 0) / allMs.length / 100) / 10

const md: string[] = [
  `# Sales simulation — ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`,
  '',
  `${passed} of ${results.length} passed · ${booked} booked · average reply ${avg}s · model ${modelName}`
    + `${withAnswers ? ' · payment and collection answers published' : ''}`,
  '',
  '| Customer | Result | Customer messages | Failing | Worth reading |',
  '|---|---|---|---|---|',
  ...results.map(({ played, findings }) => {
    const fails = findings.filter((f) => f.severity === 'fail')
    const warns = findings.filter((f) => f.severity === 'warn')
    const said = played.lines.filter((l) => l.from === 'customer').length
    return `| ${played.persona.title} | ${fails.length === 0 ? 'pass' : '**fail**'} | ${said} | `
      + `${fails.map((f) => f.rule).join('; ') || '—'} | ${warns.map((f) => f.rule).join('; ') || '—'} |`
  }),
  '',
]
for (const { played, findings } of results) {
  md.push(`## ${played.persona.title} (\`${played.persona.id}\`)`, '')
  md.push(`Expected: ${JSON.stringify(played.persona.expect)}`, '')
  if (findings.length > 0) {
    md.push(...findings.map((f) => `- **${f.severity}** — ${f.rule}: ${f.detail}`), '')
  }
  md.push('```')
  for (const l of played.lines) {
    if (l.from === 'customer') md.push(`CUSTOMER: ${l.text}`)
    else {
      md.push(`VYRA: ${l.text.replace(/\n/g, '\n      ')}`)
      if (l.photo === true) md.push('      [photos]')
      if (l.buttons !== undefined && l.buttons.length > 0) md.push(`      [${l.buttons.join(' | ')}]`)
      if (l.list !== undefined && l.list.length > 0) md.push(`      [list: ${l.list.join(' | ')}]`)
    }
  }
  md.push('```', '')
}
writeFileSync(out, md.join('\n'))
console.log(`\n${passed} of ${results.length} passed. Report: ${out}`)
process.exit(passed === results.length ? 0 : 1)

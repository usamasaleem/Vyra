import { writeFileSync } from 'node:fs'
import { anthropicModel, openaiModel } from '@vyra/agent'
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
 *   npm run simulate --workspace=app/worker -- --only terse --repeat 5     (a flaky one, five times)
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

const customerOnDeepseek = (process.env['CUSTOMER_MODEL'] ?? '').startsWith('deepseek')
const apiKey = process.env['OPENAI_API_KEY'] ?? ''
if (apiKey === '' && !(customerOnDeepseek && process.env['AGENT_PROVIDER'] === 'deepseek')) {
  console.error('OPENAI_API_KEY is not set (it is read from app/inbox/.env.local).')
  process.exit(2)
}
/**
 * The agent's model. The customers are always played by OpenAI (CUSTOMER_MODEL, default gpt-6-luna), so a
 * comparison between providers changes one thing: who answers them.
 *
 *   AGENT_PROVIDER=deepseek AI_MODEL=deepseek-flash DEEPSEEK_THINKING=disabled npm run simulate …
 */
const provider = process.env['AGENT_PROVIDER'] ?? 'openai'
const effort = process.env['AI_REASONING_EFFORT'] as 'low' | 'medium' | 'high' | undefined
const customerModelName = process.env['CUSTOMER_MODEL'] ?? 'gpt-6-luna'
let model
if (provider === 'deepseek') {
  const deepseekKey = process.env['DEEPSEEK_API_KEY']
  if (deepseekKey === undefined || deepseekKey === '') {
    console.error('DEEPSEEK_API_KEY is not set.')
    process.exit(2)
  }
  const thinking = process.env['DEEPSEEK_THINKING'] as 'enabled' | 'disabled' | undefined
  model = anthropicModel({
    apiKey: deepseekKey,
    model: process.env['AI_MODEL'] ?? 'deepseek-flash',
    baseUrl: 'https://api.deepseek.com/anthropic',
    maxTokens: 4096,
    ...(thinking === undefined ? {} : { thinking }),
    ...(effort === undefined ? {} : { effort }),
  })
} else {
  model = openaiModel({ apiKey, model: process.env['AI_MODEL'] ?? 'gpt-6-luna', ...(effort === undefined ? {} : { effort }) })
}
const modelName = model.modelId

const repeat = Math.max(1, Number(flag('--repeat') ?? 1))
const personas = (only === null ? PERSONAS : PERSONAS.filter((p) => only.includes(p.id)))
  .flatMap((p) => Array.from({ length: repeat }, () => p))
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
      persona, model, customerModel: { apiKey: customerOnDeepseek ? process.env['DEEPSEEK_API_KEY'] ?? '' : apiKey, model: customerModelName }, withAnswers,
    })
    const findings = check(played)
    results.push({ played, findings })
    const fails = findings.filter((f) => f.severity === 'fail').length
    console.log(`${fails === 0 ? 'PASS' : 'FAIL'}  ${persona.id}${fails === 0 ? '' : `  (${fails} failing)`}`)
  }
}))
results.sort((a, b) => PERSONAS.indexOf(a.played.persona) - PERSONAS.indexOf(b.played.persona))

// — The report.
const passed = results.filter((r) => r.findings.every((f) => f.severity !== 'fail')).length
const booked = results.filter((r) => r.played.facts.bookings.some((b) => b.state === 'confirmed')).length
const allMs = results.flatMap((r) => r.played.turnMs)
const avg = allMs.length === 0 ? 0 : Math.round(allMs.reduce((a, b) => a + b, 0) / allMs.length / 100) / 10
const sortedMs = [...allMs].sort((a, b) => a - b)
const pct = (p: number) => sortedMs.length === 0 ? 0 : Math.round(sortedMs[Math.min(sortedMs.length - 1, Math.floor(p * sortedMs.length))]! / 100) / 10
const allRuns = results.flatMap((r) => r.played.facts.runs)
const tokens = allRuns.reduce((t, r) => ({ input: t.input + r.input, cached: t.cached + r.cached, output: t.output + r.output }), { input: 0, cached: 0, output: 0 })
const failedTurns = allRuns.filter((r) => r.state === 'error').length

/**
 * Accuracy and consistency, the two numbers this is for.
 *
 * Accuracy: figures in the agent's messages that no record accounts for, and
 * how many messages there were. Consistency: with --repeat, how often each
 * customer passed — a customer who passes two runs in three is a flow that
 * works by luck.
 */
const invented = results.flatMap((r) => r.findings.filter((f) => f.rule === 'invented figure'))
const unpublished = results.flatMap((r) => r.findings.filter((f) => f.rule === 'policy nobody published'))
const misdated = results.flatMap((r) => r.findings.filter((f) => f.rule === 'date not on record' || f.rule === 'wrong weekday'))
const agentMessages = results.reduce((n, r) => n + r.played.facts.outbound.length, 0)
const byPersona = new Map<string, { title: string; runs: number; passes: number }>()
for (const r of results) {
  const entry = byPersona.get(r.played.persona.id) ?? { title: r.played.persona.title, runs: 0, passes: 0 }
  entry.runs++
  if (r.findings.every((f) => f.severity !== 'fail')) entry.passes++
  byPersona.set(r.played.persona.id, entry)
}
const consistency = [...byPersona.values()]

const md: string[] = [
  `# Sales simulation — ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`,
  '',
  `${passed} of ${results.length} passed · ${booked} booked · average reply ${avg}s (median ${pct(0.5)}s, 95th ${pct(0.95)}s) · model ${modelName}`
    + `${withAnswers ? ' · payment and collection answers published' : ''}`,
  '',
  `Accuracy, in ${agentMessages} agent messages: ${invented.length} invented figure${invented.length === 1 ? '' : 's'}, `
    + `${unpublished.length} unpublished polic${unpublished.length === 1 ? 'y' : 'ies'}, ${misdated.length} wrong date${misdated.length === 1 ? '' : 's'}.`,
  '',
  `Tokens over ${allRuns.length} agent turns: ${tokens.input} input (${tokens.cached} cached), ${tokens.output} output. `
    + `Turn states: ${[...new Set(allRuns.map((r) => r.state))].map((st) => `${st} ${allRuns.filter((r) => r.state === st).length}`).join(', ')}.`,
  ...(repeat > 1
    ? [
      '',
      '| Customer | Passed |',
      '|---|---|',
      ...consistency.map((c) => `| ${c.title} | ${c.passes} of ${c.runs}${c.passes === c.runs ? '' : ' ⚠️'} |`),
    ]
    : []),
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
  md.push('<details><summary>Agent turns</summary>', '')
  md.push(...played.facts.runs.map((r, i) => `${i + 1}. ${r.state}, ${Math.round(r.ms / 100) / 10}s — ${r.tools || 'no tools'}`))
  md.push('', '</details>', '')
}
writeFileSync(out, md.join('\n'))
console.log(`TOKENS ${JSON.stringify({ ...tokens, turns: allRuns.length, failedTurns, median: pct(0.5), p95: pct(0.95), avg })}`)
console.log(`\n${passed} of ${results.length} passed · in ${agentMessages} agent messages: ${invented.length} invented figures, `
  + `${unpublished.length} unpublished policies, ${misdated.length} wrong dates. Report: ${out}`)
process.exit(passed === results.length ? 0 : 1)

import type { Played } from './run.js'

/**
 * What went wrong, from the record and the words.
 *
 * Two kinds. The persona's expectation — did they end up booked, held, handed
 * over — read from the database. And the rules every conversation keeps, each
 * one a thing that has gone wrong live: "the Ferrari is free", "someone will
 * be in touch", a price three messages running, delivery buttons under a
 * question about paying.
 *
 * `fail` is a defect somebody should fix. `warn` is worth reading.
 */
export type Finding = { severity: 'fail' | 'warn'; rule: string; detail: string }

const RULES: Array<{ rule: string; severity: 'fail' | 'warn'; test: RegExp; why: string }> = [
  {
    rule: 'says "free" for available', severity: 'fail',
    test: /\b(?:is|are|it's|it is|still)\s+free\b|\bfree (?:for|on|from|this|next|between)\b/i,
    why: 'a customer reads "free" as no charge',
  },
  {
    rule: 'promises a person will follow up', severity: 'fail',
    test: /\bbe in touch\b|\bcolleague will (?:confirm|contact|call)\b|\bteam will confirm (?:it|your booking|the booking)\b|\bsend (?:it|this) to the team\b/i,
    why: 'the agent does the follow-through itself',
  },
  { rule: 'says "this morning"', severity: 'warn', test: /\bthis morning\b/i, why: 'the photos went a moment ago' },
  { rule: 'ISO date in a message', severity: 'fail', test: /\b20\d\d-\d\d-\d\d\b/, why: 'reads like a database' },
  { rule: 'Markdown bold', severity: 'fail', test: /\*\*[^*]+\*\*/, why: 'WhatsApp shows the asterisks' },
  { rule: 'Markdown link', severity: 'fail', test: /\[[^\]]+\]\([^)]+\)/, why: 'WhatsApp shows the brackets' },
]

/** The last question in a message: what a button under it must answer. */
const lastQuestion = (body: string) =>
  body.split(/(?<=[.!?؟])\s+/).filter((s) => /[?؟]\s*$/.test(s)).pop() ?? ''

export function check(played: Played): Finding[] {
  const out: Finding[] = []
  const { facts, persona } = played
  const expect = persona.expect
  const agent = facts.outbound

  // — The rules every conversation keeps.
  for (const m of agent) {
    for (const r of RULES) {
      const hit = m.body.match(r.test)
      if (hit !== null) out.push({ severity: r.severity, rule: r.rule, detail: `"…${hit[0]}…" — ${r.why}` })
    }
    if (m.buttons.includes('Delivery') && !/deliver|collect|pick/i.test(lastQuestion(m.body))) {
      out.push({ severity: 'fail', rule: 'delivery buttons under another question', detail: `"${lastQuestion(m.body) || m.body.slice(-120)}"` })
    }
    if (m.buttons.includes('Yes, book it') && !/book|hold|reserve|أحجز|احجز/i.test(lastQuestion(m.body) || m.body)) {
      out.push({ severity: 'warn', rule: 'booking buttons without a booking question', detail: `"${m.body.slice(-140)}"` })
    }
    if (m.body.length > 900) out.push({ severity: 'warn', rule: 'very long message', detail: `${m.body.length} characters` })
  }
  for (let i = 1; i < agent.length; i++) {
    if (agent[i]!.body === agent[i - 1]!.body && agent[i]!.body.trim() !== '') {
      out.push({ severity: 'fail', rule: 'sent the same message twice', detail: `"${agent[i]!.body.slice(0, 100)}"` })
    }
  }
  // The same total in three messages running before the booking is a script.
  const totals = agent.map((m): string[] => m.body.match(/AED [\d,]+/g) ?? [])
  for (let i = 2; i < totals.length; i++) {
    const shared = totals[i]!.filter((t) => totals[i - 1]!.includes(t) && totals[i - 2]!.includes(t))
    if (shared.length > 0 && !/Here is everything/.test(agent[i]!.body)) {
      out.push({ severity: 'warn', rule: 'price repeated three messages running', detail: shared[0]! })
      break
    }
  }

  for (const b of facts.bookings) {
    if (b.deliveryAddress !== null && /p\.?\s?o\.?\s*box/i.test(b.deliveryAddress)) {
      out.push({ severity: 'fail', rule: 'P.O. Box accepted as an address', detail: b.deliveryAddress })
    }
  }
  const failedRuns = facts.runs.filter((r) => r.state !== 'queued' && r.state !== 'rejected' && r.state !== 'drafted')
  if (failedRuns.length > 0) {
    out.push({ severity: 'fail', rule: 'agent turns failed', detail: failedRuns.map((r) => r.state).join(', ') })
  }
  for (const e of played.errors) out.push({ severity: 'fail', rule: 'run error', detail: e })

  // — What this customer should have ended with.
  const confirmed = facts.bookings.filter((b) => b.state === 'confirmed')
  const first = confirmed[0]
  const outcome = confirmed.length > 0 ? 'booked'
    : facts.held ? 'held'
    : facts.handoffs.length > 0 ? 'handoff'
    : 'not_booked'

  if (expect.outcome !== outcome) {
    const booked = expect.outcome === 'handoff' && facts.handoffs.length > 0
    if (!booked) {
      out.push({ severity: 'fail', rule: 'wrong outcome', detail: `expected ${expect.outcome}, got ${outcome}` })
    }
  }
  if (expect.outcome !== 'handoff' && facts.handoffs.length > 0) {
    out.push({
      severity: 'warn', rule: 'handed to a person',
      detail: facts.handoffs.map((h) => `${h.reason}: ${h.summary.slice(0, 140)}`).join(' | '),
    })
  }
  if (expect.vehicle !== undefined) {
    const got = first?.vehicle ?? facts.latestQuote?.vehicle ?? null
    if (got === null || !got.startsWith(expect.vehicle)) {
      out.push({ severity: 'fail', rule: 'wrong car', detail: `expected ${expect.vehicle}, got ${got ?? 'none'}` })
    }
  }
  if (expect.days !== undefined) {
    const got = first?.days ?? facts.latestQuote?.days ?? null
    if (got !== expect.days) {
      out.push({ severity: 'fail', rule: 'wrong number of days', detail: `expected ${expect.days}, got ${got ?? 'no quote'}` })
    }
  }
  if (expect.handover !== undefined && first !== undefined && first.handover !== expect.handover) {
    out.push({ severity: 'fail', rule: 'wrong handover', detail: `expected ${expect.handover}, got ${first.handover ?? 'not recorded'}` })
  }
  if (expect.handover !== undefined && first !== undefined && first.deliveryTime === null) {
    out.push({ severity: 'warn', rule: 'no handover time recorded', detail: 'the car has no time to go out' })
  }
  if (expect.documents !== undefined && first !== undefined && first.documents !== expect.documents) {
    out.push({ severity: 'fail', rule: 'documents not all filed', detail: `expected ${expect.documents}, got ${first.documents}` })
  }
  if (expect.summary === true && !agent.some((m) => m.body.startsWith('Here is everything for your booking'))) {
    out.push({ severity: 'fail', rule: 'no booking summary', detail: 'the booking completed without the summary' })
  }
  if (expect.extended === true && confirmed.length < 2) {
    out.push({ severity: 'fail', rule: 'not extended', detail: `${confirmed.length} confirmed booking(s)` })
  }
  return out
}

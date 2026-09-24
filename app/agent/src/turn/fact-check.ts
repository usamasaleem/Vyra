import { toolDefinitions } from '../tools/schemas.js'
import type { ModelAdapter, TranscriptEntry } from './model.js'

/**
 * Checking a reply against what the agent was actually given, before it goes.
 *
 * The prompt says "never state a figure you were not handed" and the model
 * mostly listens. Mostly is the problem: one invented deposit on the
 * operator's number is the failure this whole system exists to prevent, and
 * an instruction cannot guarantee anything. So the reply is read back against
 * its sources — the tool results, the instructions, the conversation — and a
 * figure or a claim that none of them supports is sent back to be rewritten.
 *
 * Deliberately narrow. It checks the things that are cheap to be sure about
 * and expensive to get wrong: money, percentages, "booked", "held". It does
 * not try to judge tone, or whether a sentence is true in general.
 */
export type FactProblem = {
  kind: 'amount' | 'percent' | 'booked' | 'held' | 'policy' | 'date' | 'weekday'
  said: string
}

/** "AED 12,500", "12,500 AED", "Dhs 800", "AED 1,649.85" — as a plain number string. */
// A number is digits with commas inside it, never at its end, and never glued to
// a letter: "twin-turbo V8, AED 5,000" is AED 5,000, not "8, AED".
const AMOUNT = /(?:\b(?:AED|Dhs?|dirhams?)\s?\*?(\d(?:[\d,]*\d)?(?:\.\d+)?))|(?:(?<![\w.])(\d(?:[\d,]*\d)?(?:\.\d+)?)\*?\s?(?:AED|dirhams?)\b)/gi
const PERCENT = /\b(\d{1,3})\s?(?:%|percent|per cent)/gi
const NUMBER = /\d[\d,]*(?:\.\d+)?/g

const plain = (n: string): string => {
  const v = Number(n.replace(/,/g, ''))
  return Number.isFinite(v) ? String(v) : n
}

/**
 * Every number the agent could honestly have got a figure from. Amounts in
 * minor units (a tool's `totalMinor`) are counted in major units too.
 */
export function numbersIn(sources: readonly string[]): Set<string> {
  const out = new Set<string>()
  for (const text of sources) {
    for (const m of text.matchAll(NUMBER)) {
      const v = Number(m[0].replace(/,/g, ''))
      if (!Number.isFinite(v)) continue
      out.add(String(v))
      if (Number.isInteger(v) && v >= 100 && v % 100 === 0) out.add(String(v / 100))
    }
  }
  return out
}

/** Sentences that say it is done, not that it will be or is not. */
const NEGATED = /\b(?:not|n't|yet|once|when|until|after|if|before|pending|waiting|will be|can be|to be)\b/i
// About them: "Booked —", "you're booked", "your Ferrari is confirmed". Not "the
// Ferrari has since been booked", which is somebody else's booking.
const CLAIMS_BOOKED = /^\W*booked\b|\b(?:you(?:'re| are)|it's|it is|that's|all) (?:now )?(?:booked|confirmed)\b|\byour\b[^.?!]{0,40}\bis (?:now )?(?:booked|confirmed)\b|\b(?:booked|confirmed) (?:for|in) you\b|\bconfirmed and held\b/i
// A hold says "until" as part of the claim ("held for you until 18:00"), so it
// has its own, shorter list of what undoes it.
const NEGATED_HELD = /\b(?:not|n't|if|would|could|can|shall|once)\b/i
const CLAIMS_HELD = /\b(?:held for you|holding (?:it|the [\w\s-]{1,30}) for you|is on hold for you)\b/i

/**
 * Rules a customer relies on, stated as fact. Each needs something the agent
 * was given that says it — the operator's published answers, a tool — or it
 * is the agent deciding the operator's policy for them.
 *
 * A sentence that hedges ("the team will confirm", "I'll check whether") or
 * asks is not a claim, and is left alone: that is the honest answer to a
 * question nobody has answered yet.
 */
const HEDGED = /\b(?:check|confirm|whether|not sure|find out|let you know|ask the team|team will)\b|\?\s*$/i

const POLICY_CLAIMS: Array<{ claim: RegExp; support: RegExp }> = [
  // Delivery at no charge.
  {
    claim: /\bfree delivery\b|\bdeliver(?:y|ed|ing)?\b[^.?!]{0,40}\b(?:is |are )?(?:free|complimentary|at no (?:extra )?(?:cost|charge)|no (?:extra )?charge)\b/i,
    support: /free delivery|deliver[^.]{0,80}(?:free|no charge|complimentary|at no cost)|(?:free|no charge)[^.]{0,40}deliver/i,
  },
  // Kilometres without limit.
  { claim: /\bunlimited (?:km|kms|kilomet\w*|mileage|miles)\b/i, support: /unlimited (?:km|kms|kilomet|mileage|miles)/i },
  // Insurance, fuel, Salik as included.
  {
    claim: /\binsurance\b[^.?!]{0,40}\b(?:included|covered|comprehensive|full)\b|\b(?:fully|comprehensively) insured\b/i,
    support: /insur/i,
  },
  { claim: /\bfuel\b[^.?!]{0,30}\b(?:included|free|covered|on us)\b|\bfull tank\b[^.?!]{0,20}\b(?:included|free)\b/i, support: /fuel|tank/i },
  { claim: /\b(?:salik|tolls?)\b[^.?!]{0,30}\b(?:included|free|covered)\b/i, support: /salik|toll/i },
]

/**
 * Where the car may go, either way: "you can take it to Oman" and "you can't
 * leave Dubai" are both the operator's rule to make.
 */
const PLACES = /\b(Oman|Abu Dhabi|Sharjah|Ras Al Khaimah|Fujairah|Ajman|Umm Al Quwain|Al Ain|Saudi|KSA|Qatar|Bahrain|outside (?:the )?UAE|outside Dubai|across the border)\b/i
const GOING = /\b(?:drive|driv(?:ing|en)|take|taking|travel|go|leave|cross)\b/i

/** Numbers a rule turns on: kilometres, an age, days until the deposit comes back. */
const RULE_NUMBERS: RegExp[] = [
  /(?<![\w.])(\d[\d,]*)\s?(?:km|kms|kilomet\w*)\b/gi,
  /\b(\d{2})\s?(?:\+|or (?:over|older|above)|years? (?:old|or over|and over|of age))/gi,
  /\b(?:returned|refunded|released|back)\b[^.?!]{0,30}?\b(\d{1,3})\s?(?:working )?(?:days?|hours?)\b/gi,
]

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september',
  'october', 'november', 'december']
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
const MONTH = '(january|february|march|april|may|june|july|august|september|october|november|december)'
const ORD = '(?:st|nd|rd|th)?'
/** "25th September", "25–27 September", "25th to 27th September", "1st and 3rd October". */
const DAY_MONTH = new RegExp(`\\b(\\d{1,2})${ORD}(?:\\s*(?:–|-|to|and|until|till)\\s*(\\d{1,2})${ORD})?\\s+(?:of\\s+)?${MONTH}\\b`, 'gi')
/** "September 25", "September 25th". */
const MONTH_DAY = new RegExp(`\\b${MONTH}\\s+(\\d{1,2})${ORD}\\b`, 'gi')
/** "Thursday 25th September", "Thursday, 25 September". */
const WEEKDAY_DATE = new RegExp(`\\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday),?\\s+(\\d{1,2})${ORD}\\s+(?:of\\s+)?${MONTH}\\b`, 'gi')
const ISO = /\b(20\d\d)-(\d{2})-(\d{2})\b/g

/** "month-day" keys for every date the sources mention, however they wrote it. */
function datesIn(sources: readonly string[]): Set<string> {
  const out = new Set<string>()
  for (const text of sources) {
    for (const m of text.matchAll(ISO)) out.add(`${Number(m[2])}-${Number(m[3])}`)
    for (const m of text.matchAll(DAY_MONTH)) {
      const month = MONTHS.indexOf(m[3]!.toLowerCase()) + 1
      out.add(`${month}-${Number(m[1])}`)
      if (m[2] !== undefined) out.add(`${month}-${Number(m[2])}`)
    }
    for (const m of text.matchAll(MONTH_DAY)) out.add(`${MONTHS.indexOf(m[1]!.toLowerCase()) + 1}-${Number(m[2])}`)
  }
  return out
}

export function checkReplyFacts(
  reply: string,
  context: {
    /** Everything the agent was given or told this turn: instructions, tool results, the chat. */
    sources: readonly string[]
    /** A booking is confirmed for them — before this turn or during it. */
    booked: boolean
    /** A car is held for them right now. */
    held: boolean
    /** Today, YYYY-MM-DD in the operator's clock — for which year a date is in. */
    today?: string
  },
): FactProblem[] {
  const known = numbersIn(context.sources)
  const problems: FactProblem[] = []
  const everything = context.sources.join('\n')

  for (const m of reply.matchAll(AMOUNT)) {
    const n = plain(m[1] ?? m[2] ?? '')
    if (!known.has(n)) problems.push({ kind: 'amount', said: m[0].trim() })
  }
  for (const m of reply.matchAll(PERCENT)) {
    if (!known.has(plain(m[1]!))) problems.push({ kind: 'percent', said: m[0].trim() })
  }

  const sentences = reply.split(/(?<=[.!?؟])\s+|\n+/)

  // — Policy, stated as fact.
  for (const sentence of sentences) {
    if (HEDGED.test(sentence)) continue
    for (const rule of POLICY_CLAIMS) {
      const hit = sentence.match(rule.claim)
      if (hit !== null && !rule.support.test(everything)) problems.push({ kind: 'policy', said: sentence.trim() })
    }
    const place = sentence.match(PLACES)
    if (place !== null && GOING.test(sentence) && !new RegExp(place[1]!, 'i').test(everything)
      && !/anywhere in the UAE|across the UAE|within the UAE/i.test(everything)) {
      problems.push({ kind: 'policy', said: sentence.trim() })
    }
    for (const rule of RULE_NUMBERS) {
      for (const m of sentence.matchAll(rule)) {
        if (!known.has(plain(m[1]!))) problems.push({ kind: 'policy', said: m[0].trim() })
      }
    }
  }

  // — Dates: one the record or the conversation has, on the right weekday.
  const dates = datesIn(context.sources)
  const said = new Set<string>()
  for (const m of reply.matchAll(DAY_MONTH)) {
    const month = MONTHS.indexOf(m[3]!.toLowerCase()) + 1
    for (const day of [m[1], m[2]]) if (day !== undefined) said.add(`${month}-${Number(day)}|${m[0]}`)
  }
  for (const m of reply.matchAll(MONTH_DAY)) said.add(`${MONTHS.indexOf(m[1]!.toLowerCase()) + 1}-${Number(m[2])}|${m[0]}`)
  const unknown = [...said].filter((entry) => !dates.has(entry.split('|')[0]!))
  for (const entry of new Set(unknown.map((e) => e.split('|')[1]!))) problems.push({ kind: 'date', said: entry })

  if (context.today !== undefined) {
    const [ty, tm, td] = context.today.split('-').map(Number) as [number, number, number]
    for (const m of reply.matchAll(WEEKDAY_DATE)) {
      const month = MONTHS.indexOf(m[3]!.toLowerCase())
      const day = Number(m[2])
      // The year that puts it nearest ahead: a date more than a month past is next year's.
      let year = ty
      if (Date.UTC(year, month, day) < Date.UTC(ty, tm - 1, td) - 31 * 86_400_000) year++
      const actual = WEEKDAYS[new Date(Date.UTC(year, month, day)).getUTCDay()]
      if (actual !== m[1]!.toLowerCase()) problems.push({ kind: 'weekday', said: m[0] })
    }
  }

  if (!context.booked && sentences.some((s) => CLAIMS_BOOKED.test(s) && !NEGATED.test(s))) {
    problems.push({ kind: 'booked', said: sentences.find((s) => CLAIMS_BOOKED.test(s) && !NEGATED.test(s))!.trim() })
  }
  const heldClaim = sentences.find((s) => CLAIMS_HELD.test(s) && !NEGATED_HELD.test(s))
  if (!context.held && heldClaim !== undefined) problems.push({ kind: 'held', said: heldClaim.trim() })
  return problems
}

/**
 * One more model call, no tools, to write the same reply without the problem.
 *
 * Rewriting rather than re-running the turn: the tools have already done their
 * work — a booking made, a hold placed — and doing it again is how a customer
 * gets two. The rewrite sees everything the draft saw, plus what was wrong.
 */
export async function rewriteReply(
  model: ModelAdapter,
  input: {
    system: string
    transcript: readonly TranscriptEntry[]
    draft: string
    problems: readonly FactProblem[]
  },
): Promise<string | null> {
  const why = input.problems.map((p) => {
    switch (p.kind) {
      case 'amount':
      case 'percent':
        return `"${p.said}" — that figure is not in anything you were given`
      case 'booked':
        return `"${p.said}" — nothing is booked for them`
      case 'held':
        return `"${p.said}" — nothing is held for them`
      case 'policy':
        return `"${p.said}" — nothing you were given says that; the operator has not published it, so `
          + 'say the team will confirm it, or leave it out'
      case 'date':
        return `"${p.said}" — that date is not on the booking, the quote or in the conversation`
      case 'weekday':
        return `"${p.said}" — that weekday is wrong for that date`
    }
  }).join('; ')
  const transcript = [...input.transcript]
  // The draft itself is the last agent entry; the rewrite replaces it.
  const last = transcript[transcript.length - 1]
  if (last !== undefined && last.from === 'agent' && 'text' in last) transcript.pop()
  const response = await model.complete({
    system: `${input.system}\n\nYOUR DRAFT REPLY WAS:\n"${input.draft}"\n\nIt cannot be sent as written: ${why}. `
      + 'Write the reply again. Keep everything that was right; for each problem, use the figure or '
      + 'the fact exactly as a tool or these instructions gave it, or leave it out. Never estimate, '
      + 'round or add figures together yourself.',
    transcript,
    // Defined, because the transcript refers to them; not callable this time.
    tools: toolDefinitions(),
    noTools: true,
    summary: null,
  })
  return response.reply
}

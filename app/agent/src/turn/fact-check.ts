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
export type FactProblem = { kind: 'amount' | 'percent' | 'booked' | 'held'; said: string }

/** "AED 12,500", "12,500 AED", "Dhs 800", "AED 1,649.85" — as a plain number string. */
const AMOUNT = /(?:\b(?:AED|Dhs?|dirhams?)\s?\*?(\d[\d,]*(?:\.\d+)?))|(?:(\d[\d,]*(?:\.\d+)?)\*?\s?(?:AED|dirhams?)\b)/gi
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

export function checkReplyFacts(
  reply: string,
  context: {
    /** Everything the agent was given or told this turn: instructions, tool results, the chat. */
    sources: readonly string[]
    /** A booking is confirmed for them — before this turn or during it. */
    booked: boolean
    /** A car is held for them right now. */
    held: boolean
  },
): FactProblem[] {
  const known = numbersIn(context.sources)
  const problems: FactProblem[] = []

  for (const m of reply.matchAll(AMOUNT)) {
    const n = plain(m[1] ?? m[2] ?? '')
    if (!known.has(n)) problems.push({ kind: 'amount', said: m[0].trim() })
  }
  for (const m of reply.matchAll(PERCENT)) {
    if (!known.has(plain(m[1]!))) problems.push({ kind: 'percent', said: m[0].trim() })
  }

  const sentences = reply.split(/(?<=[.!?؟])\s+|\n+/)
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
  const why = input.problems.map((p) =>
    p.kind === 'amount' || p.kind === 'percent'
      ? `"${p.said}" — that figure is not in anything you were given`
      : p.kind === 'booked'
        ? `"${p.said}" — nothing is booked for them`
        : `"${p.said}" — nothing is held for them`).join('; ')
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

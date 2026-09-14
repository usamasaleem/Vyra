/**
 * Two questions worth a tap instead of a sentence.
 *
 * WhatsApp reply buttons, used in exactly the places where the answer is
 * genuinely one of a short list. That restraint is the whole design. A rental
 * enquiry is a conversation, and an agent that answers every message with a
 * menu is the fixed-flow bot this product exists not to be — the competitor
 * screenshots that inspired this are delivery notifications, which is a
 * different job with a different shape.
 *
 * So: dates, and delivery or collection. Nothing else. Both are closed
 * questions the agent already asks in words, both currently cost a round trip,
 * and both are where a typed answer has actually gone wrong. The date
 * confirmation is the one the operator called repetitive, and a tap removes the
 * ambiguity a model then has to re-parse.
 *
 * Meta's limits: at most three buttons, titles at most 20 characters, ids at
 * most 256. Every title below is well inside that and the test asserts it,
 * because the failure mode is a send rejected at the API for a string somebody
 * lengthened months later.
 */
export type ReplyButton = { id: string; title: string }

export const DATE_CONFIRMATION: ReplyButton[] = [
  { id: 'dates_confirmed', title: 'Yes, correct' },
  { id: 'dates_wrong', title: 'Different dates' },
]

export const DELIVERY_CHOICE: ReplyButton[] = [
  { id: 'prefers_delivery', title: 'Delivery' },
  { id: 'prefers_collection', title: 'Collection' },
]

/**
 * A question about which dates, asked as a closed question.
 *
 * Deliberately narrow: it must match the shape the prompt actually produces —
 * a statement of the resolved dates followed by a check — and not an open
 * question like "which dates were you thinking?", where two buttons would be
 * useless and faintly rude.
 */
const DATE_CONFIRMATION_PATTERNS: RegExp[] = [
  /\b(?:that|is that) right\b\s*\?/i,
  /\bcorrect\?/i,
  /\bdo you mean\b[^?]{0,40}\?/i,
  /\bhave i got (?:that|those)\b[^?]{0,20}\?/i,
]

/** Month names, so a confirmation is only offered when a date is actually on the table. */
const NAMES_A_DATE =
  /\b(?:\d{1,2}(?:st|nd|rd|th)?\s*(?:to|-|–|until)\s*\d{1,2}|january|february|march|april|may|june|july|august|september|october|november|december|tomorrow|weekend)\b/i

const DELIVERY_PATTERNS: RegExp[] = [
  /\bdeliver(?:y|ed)?\b[^?]{0,30}\bor\b[^?]{0,30}\b(?:collect|pick)/i,
  /\b(?:collect(?:ing|ion)?|pick(?:ing)? (?:it )?up)\b[^?]{0,30}\bor\b[^?]{0,30}\bdeliver/i,
]

/**
 * The buttons this reply should carry, or null to send it as plain text.
 *
 * Null is the default and the common case. A reply only earns buttons by being
 * one of two specific closed questions; everything else stays a conversation.
 */
export function buttonsFor(reply: string | null): ReplyButton[] | null {
  if (reply === null || reply.trim() === '') return null

  // One question per message. A reply that asks two things cannot be answered
  // by one tap, and attaching buttons to it would answer the wrong one.
  if ((reply.match(/\?/g) ?? []).length > 1) return null

  if (DELIVERY_PATTERNS.some((p) => p.test(reply))) return DELIVERY_CHOICE

  if (NAMES_A_DATE.test(reply) && DATE_CONFIRMATION_PATTERNS.some((p) => p.test(reply))) {
    return DATE_CONFIRMATION
  }

  return null
}

/**
 * What a tapped button means, as a sentence the conversation can carry.
 *
 * A button reply comes back as an id and a title. Turning it into ordinary
 * message text is what lets the rest of the system stay unchanged: the turn,
 * the transcript, the extraction and the inbox all keep working on words, and
 * a tap reads in the history exactly as a typed answer would.
 */
const BUTTON_MEANINGS: Record<string, string> = {
  dates_confirmed: 'Yes, those dates are correct.',
  dates_wrong: 'No, those dates are wrong.',
  prefers_delivery: 'Delivery, please.',
  prefers_collection: "I'll collect it.",
}

export function meaningOfButton(id: string, title: string): string {
  return BUTTON_MEANINGS[id] ?? title
}

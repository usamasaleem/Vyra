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

/**
 * A tappable list, for the one question three buttons cannot hold: which car.
 *
 * Meta's limits, verified against the current documentation rather than
 * recalled: ten rows across at most ten sections, row title 24 characters, row
 * description 72, the button text that opens the list 20. Every one is enforced
 * here rather than trusted, because the failure is a rejected send.
 */
export type ReplyList = {
  button: string
  rows: Array<{ id: string; title: string; description?: string }>
}

/**
 * A few words the operator wants beside a car, capped so the rest of the row
 * survives.
 *
 * Eighteen characters plus the separator leaves fifty of the seventy-two for
 * colour, engine and rate — which is what they already use. Longer than this
 * and the engine starts disappearing to make room for a slogan.
 */
export const HIGHLIGHT_LIMIT = 18

export const LIST_LIMITS = {
  rows: 10,
  rowTitle: 24,
  rowDescription: 72,
  buttonText: 20,
  rowId: 200,
} as const

/**
 * The prefix that marks a row as naming a vehicle, so a tap comes back as a
 * sentence about that car rather than as a bare id.
 */
export const VEHICLE_ROW = 'vehicle:'

/**
 * A list of cars to choose from, or null to describe them in prose.
 *
 * Null whenever there is nothing to choose between: one car is an answer, not a
 * menu, and a fleet too large to list is described the way a salesperson would
 * describe it. Structure where there is a genuine choice, prose everywhere
 * else — a list attached to every reply is the flow-builder product this one is
 * deliberately not.
 */
export function vehicleList(
  vehicles: Array<{
    make: string
    model: string
    variant: string | null
    colour: string
    engine: string | null
    dayRate: string | null
    /** The operator's own few words. Shown first, because that is the point. */
    highlight?: string | null
  }>,
): ReplyList | null {
  if (vehicles.length < 2 || vehicles.length > LIST_LIMITS.rows) return null

  return {
    button: 'See the cars',
    rows: vehicles.map((v) => {
      const name = `${v.make} ${v.model}`
      // Colour first because it is what a customer recognises, then the engine,
      // then the price. Truncated on a word where it can be.
      const detail = [
        // First, because a row is read left to right and this is the thing the
        // operator wanted noticed. WhatsApp list rows have no badge or tag —
        // the description is the only place it can go.
        v.highlight === null || v.highlight === undefined || v.highlight.trim() === ''
          ? null
          : v.highlight.trim().slice(0, HIGHLIGHT_LIMIT),
        v.colour.replace(/\s*\([^)]*\)/, ''),
        v.engine,
        v.dayRate === null ? null : `${v.dayRate}/day`,
      ].filter((part): part is string => part !== null && part !== '').join(' · ')

      return {
        id: `${VEHICLE_ROW}${name}`.slice(0, LIST_LIMITS.rowId),
        title: name.slice(0, LIST_LIMITS.rowTitle),
        description: detail.slice(0, LIST_LIMITS.rowDescription),
      }
    }),
  }
}

/**
 * The reply is inviting a choice between cars.
 *
 * Narrow on purpose, and checked against the reply rather than assumed from the
 * tool call: search_vehicles returning three cars does not mean the agent asked
 * the customer to pick one. It may have been answering "what do you have in
 * orange", which is a sentence, not a menu.
 */
const ASKS_WHICH_CAR: RegExp[] = [
  /\bwhich (?:one|car|model|of (?:them|these))\b/i,
  /\b(?:any|either) of (?:them|these)\b/i,
  /\blet me know which\b/i,
  /\btake your pick\b/i,
]

export function invitesACarChoice(reply: string | null): boolean {
  if (reply === null || reply.trim() === '') return false

  /**
   * One question per message, the same rule the buttons follow. A reply that
   * confirms the dates and asks which car cannot be answered by one tap, and a
   * list beside it answers the wrong one — the customer picks a car and the
   * date question goes unanswered, which is worse than having typed.
   */
  if ((reply.match(/\?/g) ?? []).length > 1) return false

  return ASKS_WHICH_CAR.some((p) => p.test(reply))
}

/**
 * The surface for the question the agent was told to ask.
 *
 * Everything else here reads the model's prose and infers what it meant, and
 * that has failed over and over: the car list matched four phrases and missed
 * "Which one would you like to see?", the date confirmation matched one reply
 * in ninety-eight, and two rewrites of the fleet instruction measured
 * identically. Inference about intent, from the author's own sentence, while
 * the author is right there.
 *
 * `outstandingQuestions` already decided which fact the enquiry needs and the
 * turn already recorded it. That is not an inference — it is the instruction
 * the model was given a moment earlier, and v15 tells it to put exactly that
 * question at the end of the reply.
 *
 * The reply is still checked, loosely. `askedFor` says what the model was told
 * to ask; it does not prove it asked, because the same instruction says to
 * drop a question they have passed over twice. So the words have to mention
 * the thing — a far weaker test than matching a closed question, and one that
 * fails toward no surface rather than toward a wrong one.
 */
export type AskedSurface = 'delivery_choice' | 'car_list' | null

const MENTIONS_DELIVERY = /\b(?:deliver(?:y|ed|ing)?|collect(?:ion|ing)?|pick(?:ing)? (?:it )?up)\b/i
const MENTIONS_A_CHOICE = /\b(?:which|prefer|pick|choose|fancy|leaning|interests?|suits?|like)\b/i

export function surfaceForAsking(
  askedFor: string | undefined,
  reply: string | null,
): AskedSurface {
  if (askedFor === undefined || reply === null || reply.trim() === '') return null

  // One question per message, the same rule the patterns below follow: a reply
  // asking two things cannot be answered by one tap.
  if ((reply.match(/\?/g) ?? []).length > 1) return null

  if (askedFor === 'delivery_preference' && MENTIONS_DELIVERY.test(reply)) return 'delivery_choice'
  if (askedFor === 'vehicle' && MENTIONS_A_CHOICE.test(reply)) return 'car_list'
  return null
}

export const DATE_CONFIRMATION: ReplyButton[] = [
  { id: 'dates_confirmed', title: 'Yes, correct' },
  { id: 'dates_wrong', title: 'Different dates' },
]

/**
 * The customer says yes, and this is the honest version of what happens next.
 *
 * "Book it" has nowhere to go. request_booking_review is a stub that refuses,
 * there is no bookings table, and conversations.booking_status is read in six
 * places and written in none — every row is permanently 'none'. A button
 * saying "Book now" would drive somebody into that wall faster and more
 * confidently than typing would.
 *
 * So the button says what the system can actually do: put it in front of a
 * person, which is a queue that works, with an SLA, an escalation and a named
 * fallback owner. It is a smaller promise and it is a true one.
 *
 * The second button matters as much as the first. One option is not a choice,
 * and a customer who is nearly ready needs somewhere to go that is not yes.
 */
export const BOOKING_CONFIRMATION: ReplyButton[] = [
  { id: 'booking_confirm', title: 'Confirm with team' },
  { id: 'booking_wait', title: 'Not just yet' },
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
  /**
   * How it actually re-confirms a date it already has.
   *
   * Four fixed phrases matched once in ninety-eight messages. The reply that
   * prompted this read "Still looking at 19th–21st September?" — as closed a
   * question as exists, with the dates named, and it went out as plain text
   * because the wording was not on the list.
   *
   * The model is told to vary its phrasing, so a list of exact sentences will
   * always be behind it. These are shapes rather than sentences; `NAMES_A_DATE`
   * above is what keeps them honest, since none of them can fire unless a date
   * is actually on the table.
   */
  /\bstill (?:looking at|on for|on|after|planning|want(?:ing)?|the|those)\b[^?]{0,40}\?/i,
  /\bstill work(?:s|ing)?\b[^?]{0,20}\?/i,
  /\b(?:is|are) (?:that|those|these) (?:your|the)\b[^?]{0,30}\?/i,
  /\bkeep(?:ing)? (?:it|that|those|you down for)\b[^?]{0,40}\?/i,
]

/** Month names, so a confirmation is only offered when a date is actually on the table. */
const NAMES_A_DATE =
  /\b(?:\d{1,2}(?:st|nd|rd|th)?\s*(?:to|-|–|until)\s*\d{1,2}|\d{1,2}(?:st|nd|rd|th)|january|february|march|april|may|june|july|august|september|october|november|december|tomorrow|weekend)\b/i

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
  booking_confirm: 'Yes — please have someone confirm this booking.',
  booking_wait: 'Not just yet.',
}

export function meaningOfButton(id: string, title: string): string {
  // A tapped car comes back as the sentence a customer would have typed, so the
  // extraction and the transcript see a vehicle preference rather than an id.
  if (id.startsWith(VEHICLE_ROW)) return `${id.slice(VEHICLE_ROW.length)}, please.`
  return BUTTON_MEANINGS[id] ?? title
}

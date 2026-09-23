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
  /\bwhich (?:car|model|of (?:them|these))\b/i,
  // Arabic: "which car / which model / any of these"
  /(?:أي|اي)\s*(?:سيارة|سياره|موديل|واحدة|وحدة)/,
  /(?:تفضل|تحب|ترغب)\s*(?:أي|اي)?\s*(?:سيارة|سياره|واحدة)/,
  /\b(?:any|either) of (?:them|these)\b/i,
  /\blet me know which\b/i,
  /\btake your pick\b/i,
]

/**
 * "Which one" says nothing about what is being chosen between.
 *
 * Read live: "25th–27th September is 2 days, while 3 days would be 25th–28th
 * September. Which one should I use?" went out with a tappable list of the
 * fleet under it. The question was about dates; the only way to answer it was
 * to ignore the thing the message offered.
 *
 * Requiring the reply to name a car was the first attempt and it was wrong:
 * "We have three that would suit — which one appeals?" names none and is
 * plainly about cars. So the exclusion is the other way round. A reply
 * weighing up rental lengths is asking about those, and "which one" belongs
 * to them; a car named outright still wins, because "which one, the Ferrari
 * or the Huracán, for the 25th?" is a car question whatever else it mentions.
 *
 * A miss costs a list and the customer types; a false positive puts the wrong
 * surface under a question at the moment of a sale, which is what happened.
 */
const AMBIGUOUS_WHICH = /\bwhich (?:one|of those)\b/i
const WEIGHING_UP_DAYS = /\b\d+\s*(?:rental\s*)?(?:days?|nights?)\b/i
const MENTIONS_A_CAR =
  /\b(?:car|cars|vehicle|vehicles|lamborghini|ferrari|rolls[- ]?royce|bentley|mclaren|porsche|range rover|mercedes|bmw|audi|aston martin|cullinan|hurac|spider|convertible|suv)/i

export function invitesACarChoice(reply: string | null): boolean {
  if (reply === null || reply.trim() === '') return false

  /**
   * One question per message, the same rule the buttons follow. A reply that
   * confirms the dates and asks which car cannot be answered by one tap, and a
   * list beside it answers the wrong one — the customer picks a car and the
   * date question goes unanswered, which is worse than having typed.
   */
  if ((reply.match(/[?؟]/g) ?? []).length > 1) return false

  if (ASKS_WHICH_CAR.some((p) => p.test(reply))) return true
  if (!AMBIGUOUS_WHICH.test(reply)) return false
  return MENTIONS_A_CAR.test(reply) || !WEIGHING_UP_DAYS.test(reply)
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
  // Arabic ends a question with ؟, so counting only ASCII marks read a
  // two-question Arabic reply as having none and attached buttons to it.
  if ((reply.match(/[?؟]/g) ?? []).length > 1) return null

  /**
   * The question has to be about it, not the message. Live: "Perfect —
   * collection at 4:00 pm on Thursday. How would you like to pay the AED
   * 20,000 due?" carried Delivery / Collection, because the word was in the
   * statement before the question. The customer tapped Delivery, which
   * answered nothing they had been asked.
   */
  const question = reply.split(/(?<=[.!?؟])\s+/).find((s) => /[?؟]\s*$/.test(s)) ?? ''
  if (askedFor === 'delivery_preference' && MENTIONS_DELIVERY.test(question)) return 'delivery_choice'
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

/**
 * The same offer, for an operator whose agent settles bookings itself.
 *
 * "Confirm with team" promises a person who is not coming. When the agent can
 * prove the car is free it holds it on the spot, and a button describing a
 * hand-off the customer will never experience is a worse lie than a vague
 * one — it invites them to wait.
 */
export const BOOKING_NOW: ReplyButton[] = [
  { id: 'booking_confirm', title: 'Yes, book it' },
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
  // Arabic: "still …?", "is that right?", "shall I keep …?"
  /(?:لا يزال|مازال|ما زال|لسه)[^؟]{0,40}؟/,
  /(?:صحيح|صح|مضبوط|تمام)\s*؟/,
  /(?:أثبت|اثبت|أسجل|اسجل|نخليها)[^؟]{0,40}؟/,
]

/** Month names, so a confirmation is only offered when a date is actually on the table. */
/** Arabic month names and the shapes a date is said in. */
const NAMES_A_DATE_AR =
  /(?:يناير|فبراير|مارس|أبريل|ابريل|مايو|يونيو|يوليو|أغسطس|اغسطس|سبتمبر|أكتوبر|اكتوبر|نوفمبر|ديسمبر|بكرة|بكره|غدا|غداً|الويكند|نهاية الأسبوع|\d{1,2}\s*(?:إلى|الى|-|–)\s*\d{1,2})/

const NAMES_A_DATE =
  /\b(?:\d{1,2}(?:st|nd|rd|th)?\s*(?:to|-|–|until)\s*\d{1,2}|\d{1,2}(?:st|nd|rd|th)|january|february|march|april|may|june|july|august|september|october|november|december|tomorrow|weekend)\b/i

const DELIVERY_PATTERNS: RegExp[] = [
  /\bdeliver(?:y|ed)?\b[^?]{0,30}\bor\b[^?]{0,30}\b(?:collect|pick)/i,
  /\b(?:collect(?:ing|ion)?|pick(?:ing)? (?:it )?up)\b[^?]{0,30}\bor\b[^?]{0,30}\bdeliver/i,
  /**
   * The model answers in whatever language it was written to, so a customer
   * writing Arabic gets an Arabic reply — and every matcher in this file looks
   * at the reply. Without these, an Arabic conversation loses every button and
   * every list it has, which is what happens today.
   *
   * ⚠️ Model-written, wanting a native speaker's eye. A wrong match here puts
   * two buttons under a sentence they do not answer; a miss leaves the plain
   * text that is already the only outcome available.
   */
  /(?:توصيل|نوصلها|نوصله)[^؟?]{0,30}(?:أم|او|أو)[^؟?]{0,30}(?:تستلم|استلام|تاخذها|تأخذها)/,
  /(?:تستلم|استلام|تاخذها|تأخذها)[^؟?]{0,30}(?:أم|او|أو)[^؟?]{0,30}(?:توصيل|نوصلها)/,
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
  // Arabic ends a question with ؟, so counting only ASCII marks read a
  // two-question Arabic reply as having none and attached buttons to it.
  if ((reply.match(/[?؟]/g) ?? []).length > 1) return null

  if (DELIVERY_PATTERNS.some((p) => p.test(reply))) return DELIVERY_CHOICE

  if ((NAMES_A_DATE.test(reply) || NAMES_A_DATE_AR.test(reply))
    && DATE_CONFIRMATION_PATTERNS.some((p) => p.test(reply))) {
    return DATE_CONFIRMATION
  }

  return null
}

/**
 * Whether the reply is asking the customer to pick between alternatives.
 *
 * Read live, and the reason this exists. The agent replied "Ferrari 488
 * Spider delivered from 25th to 27th September is *2 rental days* — or do you
 * need 3 days, through the 27th?" and carried `Confirm with team` /
 * `Not just yet` underneath it, because the buttons are chosen from what the
 * customer said and the reply was never consulted. The customer tapped
 * Confirm with team — which cannot answer "2 or 3" — and got the same
 * question again, with the same two buttons.
 *
 * Deliberately narrow. This is not an attempt to read the model's intent out
 * of its prose, which has failed here repeatedly; it is the "A or B" shape
 * that `DELIVERY_PATTERNS` already trusts, inside the question itself. A
 * confirmation prompt ends in a question mark too, so punctuation alone
 * cannot tell them apart — the choice is what distinguishes them.
 */
/**
 * `\b` is defined on [A-Za-z0-9_], so Arabic letters are non-word characters
 * and a boundary between a space and أ never matches. Anchored on whitespace
 * instead, which is what `\b` was doing for the English half anyway.
 */
const OFFERS_A_CHOICE =
  /(?:\b(?:or)\b[^?]{0,60}\?|(?:^|\s)(?:أم|أو|او)(?:\s)[^؟]{0,60}؟)/i

export function offersAChoice(reply: string | null): boolean {
  if (reply === null || reply.trim() === '') return false
  return OFFERS_A_CHOICE.test(reply)
}

/**
 * Whether the reply itself asks to book, as one closed question.
 *
 * The booking buttons used to depend only on the customer's message sounding
 * like a booking. Live: "i want to do collection instead" did not, so the
 * reply "Would you like me to book the Ferrari 488 Spider for 24th–25th
 * September?" went out as plain text — the one question in the conversation
 * that most wants a tap. The reply is where the question is.
 *
 * Shapes, not sentences, and only a single question that is not an either/or:
 * "book the Ferrari or the Huracán?" is a choice between cars, not a yes.
 */
const ASKS_TO_BOOK: RegExp[] = [
  /\b(?:shall|should|can|may) i\b[^?]{0,20}\b(?:book|reserve|lock|hold)\b[^?]{0,80}\?/i,
  /\b(?:would|do) you (?:like|want) (?:me|us) to\b[^?]{0,20}\b(?:book|reserve|lock|hold)\b[^?]{0,80}\?/i,
  /\bready (?:for me )?to (?:book|reserve)\b[^?]{0,60}\?/i,
  // Arabic: "shall I book it?", "do you want me to book …?"
  // ⚠️ Model-written, wanting a native speaker's eye; a miss is plain text.
  /(?:أحجز|احجز|نحجز)[^؟?]{0,80}[؟?]/,
]

export function asksToBook(reply: string | null): boolean {
  if (reply === null || reply.trim() === '') return false
  if ((reply.match(/[?؟]/g) ?? []).length > 1) return false
  if (offersAChoice(reply)) return false
  return ASKS_TO_BOOK.some((p) => p.test(reply))
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
  booking_confirm: 'Yes — please confirm this booking.',
  booking_wait: 'Not just yet.',
}

export function meaningOfButton(id: string, title: string): string {
  // A tapped car comes back as the sentence a customer would have typed, so the
  // extraction and the transcript see a vehicle preference rather than an id.
  if (id.startsWith(VEHICLE_ROW)) return `${id.slice(VEHICLE_ROW.length)}, please.`
  return BUTTON_MEANINGS[id] ?? title
}

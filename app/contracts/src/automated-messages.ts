import { hasUnfilledBlank } from './policy-topics.js'

/**
 * Messages the system sends on its own, in the operator's words.
 *
 * Deliberately not in POLICY_TOPICS. That list is what `get_operator_policy`
 * accepts — `z.enum(POLICY_TOPICS)` — so a topic outside it cannot be fetched
 * by the model at all, which is right: these are not answers to anything. The
 * agent never reads them and never quotes them. They are sent, whole, by code.
 *
 * Stored in `knowledge_entries` all the same, because everything that table
 * guarantees applies here too: a version, an effective window, and since this
 * morning an account behind every published row. A greeting that goes to every
 * new customer is at least as much the operator's voice as their deposit
 * policy.
 *
 * Nothing has a default. An unwritten message is not sent — the operator's
 * greeting cannot be guessed, and an invented one is the mistake this project
 * spent a day undoing.
 */
export const AUTOMATED_MESSAGES = [
  /**
   * The first thing a new contact ever hears, before the agent answers them.
   *
   * Once per contact, ever. Not per conversation: a conversation reopens for
   * years and being welcomed again in March is being told you are a stranger.
   */
  'greeting',
  /**
   * Sent when they write and nobody is in.
   *
   * The agent still answers — it is the people who are unavailable, not the
   * system. So this is about what happens to anything needing a person, and
   * the operator is the only one who can say what that is.
   */
  'out-of-hours',
  /**
   * The first chase, sent word for word when a customer goes quiet.
   *
   * Lived in POLICY_TOPICS, between the deposit and the kilometre allowance,
   * on a page called "What the agent may say". It is not an answer to
   * anything, and it went unwritten for the entire pilot — eleven chases
   * became tasks for a person instead of messages to a customer.
   */
  'follow-up-message',
  /**
   * And the second, which has to say something the first did not.
   *
   * One wording reused for every attempt is what produced two identical
   * messages thirty minutes apart. A machine repeats itself; a salesperson
   * following up has a new reason to be in touch.
   */
  'follow-up-message-2',
  /**
   * The day before the car goes out. The booking's details are added
   * underneath by the system — this is only the part in the operator's voice.
   */
  'handover-reminder',
  /**
   * The day before it comes back: keep it longer, or when shall we collect it.
   * The agent handles whichever they answer.
   */
  'return-reminder',
  /**
   * Once somebody has marked the car back. Where a review link belongs, if the
   * operator wants one.
   */
  'thank-you',
] as const

export type AutomatedMessage = (typeof AUTOMATED_MESSAGES)[number]

export function isAutomatedMessage(value: string): value is AutomatedMessage {
  return (AUTOMATED_MESSAGES as readonly string[]).includes(value)
}

/**
 * What the screen calls each one, and why an operator would write it.
 *
 * `starter` is wording to begin from, not a default. Nothing sends it: it
 * reaches a customer only once somebody has read it, put their name to it and
 * pressed the button, which is the same bar every other published row clears.
 * The distinction matters because a blank box asks an operator to compose in
 * their own voice from nothing, and four of them stayed blank for the whole
 * pilot. A draft to argue with is a far easier thing to face than an empty
 * field, and arguing with it is how it stops being ours.
 *
 * So the wording here is deliberately plain and claims nothing — no price, no
 * hour, no promise about what happens next. Published verbatim it is merely
 * unremarkable, which is the worst it is allowed to be.
 */
export const AUTOMATED_MESSAGE_LABELS: Record<AutomatedMessage, {
  title: string
  why: string
  /** Given the operator's own name, because a greeting that names the wrong business is worse than none. */
  starter: (business: string) => string
}> = {
  greeting: {
    title: 'First message to a new customer',
    why: 'Sent once, when a new customer opens with only a hello. If their first message '
      + 'already asks for something, the answer is the welcome and this is not sent. Nobody is '
      + 'ever greeted twice, however long they have been away.',
    starter: (business) => `Thanks for getting in touch with ${business}. Happy to help `
      + `with anything about the cars — just say what you are looking for and when.`,
  },
  'out-of-hours': {
    title: 'When they write and nobody is in',
    why: 'The agent still answers at 3am. This is for what it cannot do without you — '
      + 'so say when somebody will pick it up, not that you are closed.',
    starter: () => 'We are away from the desk right now, but I can still help with the '
      + 'cars and your dates. Anything that needs one of the team will be picked up as '
      + 'soon as we are back in.',
  },
  'follow-up-message': {
    title: 'Chasing a customer who went quiet',
    why: 'Sent word for word, once, after the gap set in Settings. Until it is written '
      + 'the chase becomes a task for one of your people instead.',
    starter: () => 'Still thinking it over? Happy to answer anything about the car or '
      + 'the dates whenever you are ready.',
  },
  'handover-reminder': {
    title: 'The day before the car goes out',
    why: 'Sent the day before, between 10:00 and 20:00, with the car, the time and the place '
      + 'added underneath — and anything still unpaid or missing, which is the last chance to '
      + 'catch it before a driver is at the door.',
    starter: () => 'Looking forward to tomorrow! Here is what we have for you — just reply if '
      + 'anything has changed.',
  },
  'return-reminder': {
    title: 'The day before it comes back',
    why: 'Sent the day before the rental ends. Whatever they answer — a time, or more days — '
      + 'the agent takes it from there, and extends the booking if the car is free.',
    starter: () => 'Hope you are enjoying the car! Your rental ends tomorrow. Would you like to '
      + 'keep it a little longer? If not, just tell me what time suits for the return.',
  },
  'thank-you': {
    title: 'When the car is back',
    why: 'Sent when one of your people marks the car returned on the Handovers page. If you '
      + 'want reviews, this is where the link goes.',
    starter: (business) => `Thank you for renting with ${business}! We hope you enjoyed it. `
      + 'If you have a moment, a review would mean a lot: ___',
  },
  'follow-up-message-2': {
    title: 'And chasing a second time',
    why: 'It has to say something the first one did not. Reusing one wording is what '
      + 'sends the same sentence twice, half an hour apart, and reads as a machine.',
    starter: () => 'No rush at all. I will leave it with you — just say the word if you '
      + 'would like me to pick it back up.',
  },
}

/**
 * The starter as it can be published in one tap, or null when it cannot.
 *
 * The thank-you leaves a blank for a review link, which only the operator can
 * fill. Offering that sentence in one tap would publish a gap, so the tap
 * takes the starter without it — every sentence with a blank dropped — and
 * the operator who wants the review line uses Edit. Null only if nothing is
 * left, which no starter today does.
 */
export function readyStarter(topic: AutomatedMessage, business: string): string | null {
  const starter = AUTOMATED_MESSAGE_LABELS[topic].starter(business)
  if (!hasUnfilledBlank(starter)) return starter
  const kept = (starter.match(/[^.!?]+[.!?:]*\s*/g) ?? [])
    .filter((sentence) => !hasUnfilledBlank(sentence))
    .join('')
    .trim()
  return kept === '' ? null : kept
}

/**
 * Whether a message is only a hello, with nothing asked.
 *
 * The greeting went out ahead of every first message. Live: "Hi, do you have
 * a Ferrari" got "Thanks for getting in touch… just say what you are looking
 * for and when" and then, ten seconds later, the answer — a welcome asking a
 * question the customer had already answered, in front of the reply that
 * answered them. When somebody opens with a request, the answer is the
 * welcome.
 *
 * Closed on purpose: the words that make up a hello, and nothing else. Any
 * word that is not on the list means they said something, and that is the
 * safe way to be wrong — a missed greeting costs nothing.
 */
const HELLO_WORDS = new Set([
  'hi', 'hii', 'hiii', 'hello', 'helo', 'hallo', 'hey', 'heya', 'hiya', 'yo', 'hola', 'bonjour',
  'salam', 'salaam', 'salām', 'salamu', 'salaamu', 'assalam', 'assalamu', 'asalamu', 'assalamualaikum', 'alaikum',
  'alaykum', 'aleikum', 'as', 'wa', 'marhaba', 'good', 'morning', 'afternoon', 'evening', 'day',
  'there', 'team', 'all', 'sir', 'madam', 'guys', 'dear', 'again', 'everyone', 'friend',
  'مرحبا', 'مرحباً', 'السلام', 'عليكم', 'سلام', 'اهلا', 'أهلا', 'هلا', 'صباح', 'مساء', 'الخير', 'النور',
])

export function isOnlyAGreeting(body: string | null): boolean {
  if (body === null) return false
  const words = body
    .toLowerCase()
    // Punctuation, emoji and the like are not words; hyphens split "as-salamu".
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w !== '')
  return words.length > 0 && words.every((w) => HELLO_WORDS.has(w))
}

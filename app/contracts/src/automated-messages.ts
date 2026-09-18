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
] as const

export type AutomatedMessage = (typeof AUTOMATED_MESSAGES)[number]

export function isAutomatedMessage(value: string): value is AutomatedMessage {
  return (AUTOMATED_MESSAGES as readonly string[]).includes(value)
}

/** What the screen calls each one, and why an operator would write it. */
export const AUTOMATED_MESSAGE_LABELS: Record<AutomatedMessage, {
  title: string
  why: string
  placeholder: string
}> = {
  greeting: {
    title: 'First message to a new customer',
    why: 'Sent once, before the agent answers their first message. Nobody is ever '
      + 'greeted twice, however long they have been away.',
    placeholder: 'Thanks for getting in touch with Vyra Rentals — happy to help with '
      + 'anything about the cars.',
  },
  'out-of-hours': {
    title: 'When they write and nobody is in',
    why: 'The agent still answers at 3am. This is for what it cannot do without you — '
      + 'so say when somebody will pick it up, not that you are closed.',
    placeholder: 'We are away from the desk right now, but I can still help. Anything '
      + 'needing a colleague will be picked up when we open in the morning.',
  },
}

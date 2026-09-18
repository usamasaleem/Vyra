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
  'follow-up-message': {
    title: 'Chasing a customer who went quiet',
    why: 'Sent word for word, once, after the gap set in Settings. Until it is written '
      + 'the chase becomes a task for one of your people instead.',
    placeholder: 'Still thinking about those dates? Happy to help if you have any questions.',
  },
  'follow-up-message-2': {
    title: 'And chasing a second time',
    why: 'It has to say something the first one did not. Reusing one wording is what '
      + 'sends the same sentence twice, half an hour apart, and reads as a machine.',
    placeholder: 'No rush at all — just let me know if you would like me to hold anything.',
  },
}

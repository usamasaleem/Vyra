/**
 * The messages that may go out after 24 hours of silence.
 *
 * WhatsApp allows a business to write freely only within 24 hours of the
 * customer's last message. Outside it, only a template Meta has approved may
 * be sent — so the day-before reminder for a car booked a week ago, a follow-up
 * the next morning, and a colleague's answer to a question asked yesterday all
 * became tasks for a person. These are what the agent needs to keep
 * going on its own.
 *
 * Fixed wording with the facts as parameters, because that is what Meta
 * approves: the sentence is reviewed once, and each send fills in the name, the
 * car and the day. Parameters never carry a newline or a tab (Meta refuses
 * them), and each has an example, which Meta requires for review.
 */
export type TemplateCategory = 'UTILITY' | 'MARKETING'

export type TemplateDefinition = {
  name: string
  category: TemplateCategory
  language: string
  /** With {{1}}, {{2}}… where the parameters go. */
  body: string
  /** One value per parameter, shown to Meta's reviewers. */
  example: string[]
  /** What it is for, for the settings page. */
  purpose: string
}

export const TEMPLATES = {
  handover_reminder: {
    name: 'vyra_handover_reminder',
    category: 'UTILITY',
    language: 'en',
    body: 'Hello {{1}}, a reminder that your {{2}} rental starts tomorrow, {{3}}. {{4}} If anything has changed, just reply to this message.',
    example: ['James', 'Ferrari 488 Spider', 'Friday 26 September', 'We will deliver it to Atlantis The Palm at 10:00.'],
    purpose: 'The day before a car goes out, when the customer has been quiet for more than a day.',
  },
  return_reminder: {
    name: 'vyra_return_reminder',
    category: 'UTILITY',
    language: 'en',
    body: 'Hello {{1}}, your {{2}} rental ends tomorrow, {{3}}. {{4}} If you would like to keep the car longer, reply to this message and we will check it for you.',
    example: ['James', 'Ferrari 488 Spider', 'Sunday 28 September', 'We will collect it from Atlantis The Palm at 18:00.'],
    purpose: 'The day before a car comes back, when the customer has been quiet for more than a day.',
  },
  reply_waiting: {
    name: 'vyra_reply_waiting',
    category: 'UTILITY',
    language: 'en',
    body: 'Hello {{1}}, we have a reply for you about your {{2}}. Please reply to this message to see it.',
    example: ['James', 'Ferrari 488 Spider booking'],
    purpose: 'Reopens the conversation when a reply is ready but the customer has been quiet for more than a day.',
  },
  quote_follow_up: {
    name: 'vyra_quote_follow_up',
    category: 'MARKETING',
    language: 'en',
    body: 'Hello {{1}}, the {{2}} is still available for {{3}}. Would you like us to reserve it for you? Reply to this message and we will take care of it.',
    example: ['James', 'Ferrari 488 Spider', '26 to 28 September'],
    purpose: 'A follow-up on a price the customer was given, when they have been quiet for more than a day.',
  },
  waitlist_available: {
    name: 'vyra_waitlist_available',
    category: 'UTILITY',
    language: 'en',
    body: 'Hello {{1}}, good news: the {{2}} you asked us to watch for is now available for {{3}}. Would you like us to book it for you? Reply to this message and we will take care of it.',
    example: ['James', 'Lamborghini Huracán', '26 to 28 September'],
    purpose: 'Tells a customer on the waitlist that the car they wanted has come free, when they have been quiet for more than a day.',
  },
} as const satisfies Record<string, TemplateDefinition>

export type TemplateKey = keyof typeof TEMPLATES

/** A parameter as Meta will take it: one line, no tabs, no run of spaces, never empty. */
export function templateParam(value: string): string {
  const cleaned = value.replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim()
  return cleaned === '' ? '-' : cleaned.slice(0, 900)
}

/** The sentence the customer will read, for the inbox and the record. */
export function renderTemplate(key: TemplateKey, params: readonly string[]): string {
  return TEMPLATES[key].body.replace(/\{\{(\d+)\}\}/g, (_, n: string) => templateParam(params[Number(n) - 1] ?? ''))
}

/** How many parameters a template takes. */
export function templateArity(key: TemplateKey): number {
  return new Set(TEMPLATES[key].body.match(/\{\{\d+\}\}/g) ?? []).size
}

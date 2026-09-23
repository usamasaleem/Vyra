/**
 * What WhatsApp actually renders, and repairing the near-misses.
 *
 * The prompt has said "plain text, WhatsApp does not render Markdown" since
 * v2, and that was an over-correction. What happened in v1 was the model
 * writing `**bold**` — two asterisks, which is Markdown — and a customer
 * receiving "Lamborghini from **Thursday**" with the asterisks showing. The
 * conclusion drawn was that WhatsApp has no formatting. It has plenty:
 * *bold*, _italic_, ~strikethrough~, bulleted and numbered lists, and block
 * quotes on Cloud API v18 and later. One asterisk, not two.
 *
 * So the rule was right about the symptom and wrong about the cause, and the
 * cost was every message since being a wall of prose — including a list of
 * three cars with their colours, engines and prices run together in
 * paragraphs.
 *
 * Permitting it in the prompt is not enough on its own. A model told it may
 * use bold will reach for the Markdown it has seen a billion times, so the
 * repair below is the guarantee and the prompt is the courtesy.
 */

/**
 * Turn a model's Markdown reflexes into what WhatsApp draws.
 *
 * Conservative on purpose. It fixes the four things a model actually does and
 * leaves everything else alone — a reply is a person's words and rewriting
 * them is not something this system does. Asterisks that are not a formatting
 * pair, a lone underscore in a model name, a stray hash: all untouched.
 */
export function asWhatsAppText(reply: string): string {
  return reply
    // **bold** and __bold__ are Markdown. WhatsApp wants one of each.
    .replace(/\*\*(?=\S)([^*]+?)(?<=\S)\*\*/g, '*$1*')
    .replace(/__(?=\S)([^_]+?)(?<=\S)__/g, '_$1_')
    // A Markdown heading arrives as a visible hash. The line is still a
    // heading in intent, so it becomes bold rather than losing emphasis.
    .replace(/^#{1,6}[ \t]+(.+)$/gm, '*$1*')
    // [text](url) shows both halves. The customer wants the words; a raw URL
    // in a sales message is noise, and any link that matters is one we sent.
    .replace(/\[([^\]]+)\]\((?:https?:\/\/[^)\s]+)\)/g, '$1')
}

/**
 * A date the way somebody writes it in a message.
 *
 * Never the ISO form. "Valid until 2026-09-17" is the exact thing the
 * instructions forbid the model from writing, and it was going out anyway
 * because the quote is rendered by code — a rule enforced on the model and
 * not on ourselves.
 *
 * No year, for the same reason the prompt gives: nobody writes one about next
 * week, and it is most of what makes a message read like a database.
 */
export function formatDateForMessage(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone, weekday: 'long', day: 'numeric', month: 'long',
  }).format(date)
}

/**
 * When something happened, the way somebody says it out loud.
 *
 * Not "on 15 September", and above all not "7 photos on the 15th". That exact
 * sentence went to a customer three times in six minutes, with the count
 * changing to 9 the fourth time, and it is the single clearest tell in the
 * whole transcript that they are not talking to a person.
 *
 * The cause was not the model. The fact it was handed read "7 of the
 * Lamborghini Huracán on 15 September", so it said a number and a date — a
 * model repeats the precision it is given, and no instruction talks it out of
 * a value that is sitting in its context. The fix is to hand it the vaguer
 * truth in the first place.
 */
export function relativeDay(at: Date, now: Date, timeZone: string): string {
  const day = (d: Date) =>
    new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
      .format(d)

  const days = Math.round(
    (Date.parse(`${day(now)}T00:00:00Z`) - Date.parse(`${day(at)}T00:00:00Z`)) / 86_400_000,
  )

  /**
   * Minutes, not "today". Live: photographs sent one minute earlier were
   * described as "this morning" at six in the evening — the model was told
   * "earlier today" and reached for the nearest phrase it knew.
   */
  if (now.getTime() - at.getTime() < 15 * 60_000) return 'a moment ago'
  if (days <= 0) return 'earlier today'
  if (days === 1) return 'yesterday'
  // Inside a week a weekday still locates it — "on Tuesday" is how somebody
  // says it, where "6 days ago" is how a system counts.
  if (days < 7) {
    return `on ${new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'long' }).format(at)}`
  }
  if (days < 14) return 'last week'
  return 'a while back'
}

/**
 * Whether a customer has finished typing, as far as one message can tell.
 *
 * The collection window waits two seconds before every turn, because people do
 * not type in paragraphs — "can you give me another car", "maybe a ferrari",
 * "in yellow?" arrive across fifteen seconds and each one would otherwise
 * start its own reply.
 *
 * It is right, and it is paid on every message including the ones nothing
 * follows. Two seconds on a reply that already takes seven is most of a third
 * of the wait, spent on a burst that usually does not come.
 *
 * A message that ends in a full stop or a question mark is a message somebody
 * finished. A fragment — "hi", "lambo", "yellow?" — is somebody mid-thought,
 * and those are exactly the bursts the window exists for. So the wait is short
 * for the first and unchanged for the second.
 *
 * Deliberately crude, and the failure is cheap in both directions: guess wrong
 * on a finished message and two fragments get two replies, which the revision
 * check already handles; guess wrong on a fragment and somebody waits the full
 * two seconds they would have waited anyway.
 */
export function looksFinished(body: string | null): boolean {
  if (body === null) return false
  const text = body.trim()
  if (text === '') return false

  // Ends the way somebody ends a thought. Anything after the punctuation that
  // is not a letter or a number — a closing bracket, an emoji, a trailing
  // space — is still part of the ending rather than a new thought.
  if (/[.!?][^\p{L}\p{N}]*$/u.test(text)) return true

  /**
   * Or long enough that it is plainly a whole message. Twenty-five characters
   * is about "do you have a lamborghini" — above it people punctuate or do not
   * bother, and below it they are usually still going.
   */
  return text.length >= 25
}

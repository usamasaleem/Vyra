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

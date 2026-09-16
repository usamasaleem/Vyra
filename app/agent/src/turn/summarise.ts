import type { ModelAdapter } from './model.js'

/**
 * Writing down what the window is about to forget.
 *
 * A separate, cheap call rather than something the reply turn produces. Two
 * reasons: the customer is waiting on the reply and must not pay for this in
 * latency, and a turn asked to both answer and summarise does neither
 * attentively.
 *
 * The instruction is narrow on purpose. Everything a salesperson needs to act
 * on — the dates, the car, delivery, the budget — is already in field_evidence
 * with the message that proved it, which beats a paraphrase: it is exact,
 * attributable, and a later value supersedes an earlier one. So this is asked
 * for the residue, which is the part a structured field cannot hold: what they
 * want that no field captures, what they have been told, what is outstanding.
 *
 * It used to ask for two more things and both were mistakes.
 *
 * It asked how the customer talks, and got back "terse, sometimes uses
 * profanity, has briefly gone off-topic" — a character assessment of a real
 * person, written by a model, read before every reply, and never reviewed by
 * anybody. None of it changes what the right answer is.
 *
 * And it asked for anything they "asked twice", which produced "they
 * repeatedly request all photos and different angles". They asked three times
 * because the photographs were not being sent. The bug is fixed; the note
 * outlived it and had become a fact about the customer. A summary written from
 * a transcript cannot tell a demanding customer from a customer we failed, and
 * should not be asked to guess — so it is asked what is outstanding instead,
 * which is the same observation pointed at us.
 */
const SUMMARY_INSTRUCTIONS = `You are keeping notes on an enquiry, from a WhatsApp conversation between a luxury car rental company and a customer.

Write what a salesperson would need to know that is NOT a simple field:
- What they want that a field cannot hold — the occasion, a constraint, a preference between two cars.
- What they have already been told, so nobody repeats it or contradicts it.
- What is still outstanding: anything they asked for and have not had, and anything we said we would come back on.
- Circumstances that change the right answer: visiting or resident, first time or returning, who the car is for.

Do NOT list dates, the vehicle, delivery preference or budget. Those are recorded separately and exactly; repeating them here risks a stale copy competing with the real one.

Do NOT describe the customer. Not their manner, their tone, their patience, or what sort of person they seem to be. It is a real person, nobody reviews these notes, and none of it changes what the right answer is. If they asked for something more than once, that is a note about what is outstanding, not about them.

Rules:
- Under 120 words. It is read before every reply and paid for every time.
- Only what was actually said. If the conversation shows nothing worth noting, say "Nothing beyond the recorded details."
- Plain sentences. No headings, no bullets.`

export async function summariseConversation(
  model: ModelAdapter,
  input: {
    /** Oldest first. Only the messages that have fallen out of the window. */
    messages: Array<{ direction: string; body: string }>
    /** What was summarised before this, if anything. */
    previous: string | null
  },
): Promise<string | null> {
  if (input.messages.length === 0) return null

  const transcript = input.messages
    .map((m) => `${m.direction === 'inbound' ? 'Customer' : 'Agent'}: ${m.body}`)
    .join('\n')

  const previous = input.previous === null
    ? ''
    : `Notes so far, which you are updating rather than replacing:\n${input.previous}\n\n`

  const response = await model.complete({
    system: SUMMARY_INSTRUCTIONS,
    transcript: [{ from: 'customer', text: `${previous}Conversation:\n${transcript}` }],
    // No tools. This call reads and writes nothing; giving it a tool boundary
    // would be handing it the ability to act on a conversation it is only
    // meant to describe.
    tools: [],
  })

  const text = response.reply?.trim()
  return text === undefined || text === '' ? null : text
}

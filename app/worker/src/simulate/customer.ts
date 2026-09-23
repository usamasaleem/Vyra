/**
 * A model playing the customer.
 *
 * It sees the chat the way a customer sees WhatsApp — the business's messages,
 * the buttons under them, that photographs arrived — and answers with one
 * action. It never sees the system prompt, the tools or the database: a
 * simulated customer who knows how the agent works is testing nothing.
 */
export type Line =
  | { from: 'customer'; text: string }
  | { from: 'business'; text: string; buttons?: string[]; list?: string[]; photo?: boolean }

export type CustomerAction =
  | { message: string }
  | { tap: string }
  | { photo: string }
  | { photos: string[] }
  | { wait: true }
  | { done: string }

const RULES = `You are playing a customer messaging a luxury car rental company in Dubai on WhatsApp.
Stay in character and follow your brief. You do not know you are talking to software.

Reply with ONE JSON object and nothing else, one of:
{"message": "what you type"}          — a WhatsApp message, written the way your brief says you write
{"tap": "Exact button title"}         — tap one of the buttons under the business's LAST message
{"photo": "licence"}                  — send one photo (licence, id, passport, or anything)
{"photos": ["licence", "id"]}         — send several photos at once
{"wait": true}                        — go quiet and wait for them to follow up (only if your brief says to)
{"done": "short reason"}              — the conversation is over for you

Only tap a button that is actually shown. Do not repeat yourself word for word. When your booking
is fully confirmed and you have nothing left to do, reply {"done": "booked"}. If the business asks
something your brief does not cover, answer sensibly and briefly, in character.`

function render(lines: Line[]): string {
  if (lines.length === 0) return '(No messages yet. Write your first message.)'
  return lines.map((l) => {
    if (l.from === 'customer') return `YOU: ${l.text}`
    const extras = [
      l.photo === true ? '[photos of the car attached]' : null,
      l.buttons !== undefined && l.buttons.length > 0 ? `[buttons: ${l.buttons.join(' | ')}]` : null,
      l.list !== undefined && l.list.length > 0 ? `[tappable list: ${l.list.join(' | ')}]` : null,
    ].filter((x) => x !== null)
    return `BUSINESS: ${l.text}${extras.length > 0 ? `\n${extras.join('\n')}` : ''}`
  }).join('\n\n')
}

export async function nextAction(input: {
  apiKey: string
  model: string
  brief: string
  lines: Line[]
}): Promise<CustomerAction> {
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { authorization: `Bearer ${input.apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: input.model,
      reasoning: { effort: 'low' },
      instructions: `${RULES}\n\nYOUR BRIEF:\n${input.brief}`,
      input: `The chat so far:\n\n${render(input.lines)}\n\nYour next action, as JSON:`,
    }),
    signal: AbortSignal.timeout(60_000),
  })
  if (!response.ok) throw new Error(`customer model ${response.status}: ${await response.text()}`)
  const data = await response.json() as {
    output?: Array<{ type: string; content?: Array<{ type: string; text?: string }> }>
  }
  const text = (data.output ?? [])
    .filter((o) => o.type === 'message')
    .flatMap((o) => o.content ?? [])
    .map((c) => c.text ?? '')
    .join('')
  const json = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)
  try {
    return JSON.parse(json) as CustomerAction
  } catch {
    // A customer who says something unparseable still said something.
    return { message: text.trim() || 'ok' }
  }
}

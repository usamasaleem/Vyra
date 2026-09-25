/**
 * A photo a customer sent, in words the agent can read.
 *
 * Until this existed every photo outside a booking went to a person with "we
 * can't open photos here": the Instagram screenshot of the car they wanted, a
 * picture of the hotel entrance, a transfer receipt. The agent never saw any
 * of them, and a salesperson was asked to look at each one.
 *
 * The description is what the agent reads in place of the picture, so it is
 * plain and short, and it is honest about what it cannot tell. Identity
 * documents are named and never transcribed: a licence number or a date of
 * birth has no business in a sales conversation's text, and the photo itself
 * stays in the inbox for the person who checks it.
 */
const TIMEOUT_MS = 30_000

const INSTRUCTIONS = `A customer of a luxury car rental company in Dubai sent this photo on WhatsApp.
Describe it in one or two plain sentences, for the salesperson answering them.

- If a car is shown, say which make and model and colour when you can clearly tell, and say so when you cannot be sure.
- If it is a screenshot (an advert, a social media post, a website, a chat), say what it shows and copy any car names, dates or prices visible in it exactly.
- If it is a payment receipt or a bank transfer, say so, with the amount and currency shown.
- If it is a driving licence, passport, Emirates ID or any other identity document, say only which kind of document it is and which country issued it. Never copy a name, number or date from it.
- If it is a place (a hotel, a building, a map), say what and where if it is shown.
- Anything else: what it is, briefly.

Write only the description. No greeting, no advice, no guesses presented as facts.`

export type PhotoReader = (input: {
  bytes: Uint8Array<ArrayBuffer>
  mimeType: string
}) => Promise<string | null>

export function openaiPhotoReader(options: {
  apiKey: string
  model: string
  baseUrl?: string
  timeoutMs?: number
  fetchImpl?: typeof fetch
}): PhotoReader {
  const baseUrl = options.baseUrl ?? 'https://api.openai.com'
  const doFetch = options.fetchImpl ?? fetch

  return async ({ bytes, mimeType }) => {
    if (!/^image\/(?:jpeg|png|webp|gif)$/.test(mimeType)) return null
    const response = await doFetch(`${baseUrl}/v1/responses`, {
      method: 'POST',
      signal: AbortSignal.timeout(options.timeoutMs ?? TIMEOUT_MS),
      headers: { authorization: `Bearer ${options.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: options.model,
        // Somebody else's customer's photo: no copy left with the provider.
        store: false,
        reasoning: { effort: 'low' },
        instructions: INSTRUCTIONS,
        input: [{
          role: 'user',
          content: [{
            type: 'input_image',
            image_url: `data:${mimeType};base64,${Buffer.from(bytes).toString('base64')}`,
          }],
        }],
      }),
    })
    if (!response.ok) {
      throw new Error(`photo reader ${response.status}: ${(await response.text()).slice(0, 300)}`)
    }
    const body = (await response.json()) as {
      output?: Array<{ type: string; content?: Array<{ type: string; text?: string }> }>
    }
    const text = (body.output ?? [])
      .filter((o) => o.type === 'message')
      .flatMap((o) => o.content ?? [])
      .map((c) => c.text ?? '')
      .join('')
      .trim()
    return text === '' ? null : text.slice(0, 600)
  }
}

/**
 * What the agent and the salesperson read in place of the photo.
 *
 * Marked as a description, so nobody — the agent included — mistakes it for
 * something the customer typed.
 */
export function photoAsWords(description: string, caption: string | null): string {
  const said = caption !== null && caption.trim() !== '' ? `\nTheir caption: "${caption.trim()}"` : ''
  return `[Photo from the customer, described automatically: ${description}]${said}`
}

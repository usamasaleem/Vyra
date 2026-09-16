import { carChosenInFlow, meaningOfButton, VEHICLE_ROW } from '@vyra/contracts'
import { z } from 'zod'

/**
 * The shape Meta actually sends, confirmed against a real inbound message on
 * 13 September 2026 rather than taken from documentation. Section 18.4 is
 * explicit that these fields must be validated during channel integration.
 *
 * Unknown properties are stripped here and NOT lost: the untouched payload is
 * stored in `inbound_events.payload`. The live payload carried `user_id` and
 * `from_user_id`, which no schema here anticipated — that is the argument for
 * keeping the raw copy.
 */

const metadataSchema = z.object({
  display_phone_number: z.string().optional(),
  /** The receiving number. The only trustworthy routing key. */
  phone_number_id: z.string(),
})

const contactSchema = z.object({
  wa_id: z.string(),
  profile: z.object({ name: z.string().optional() }).optional(),
})

const messageSchema = z.object({
  id: z.string(),
  from: z.string(),
  /** Unix seconds, as a string. */
  timestamp: z.string(),
  type: z.string(),
  text: z.object({ body: z.string() }).optional(),
  /**
   * A tapped reply button. Meta sends the id we chose and the title the
   * customer saw; both matter, and the id is the one that cannot be mistyped.
   */
  interactive: z.object({
    type: z.string(),
    button_reply: z.object({ id: z.string(), title: z.string() }).optional(),
    list_reply: z.object({ id: z.string(), title: z.string() }).optional(),
    /**
     * A Flow that finished. The answer is a JSON string rather than the
     * id-and-title pair a tap gives, because a Flow can collect anything —
     * ours collects which car.
     */
    nfm_reply: z.object({
      response_json: z.string(),
      body: z.string().optional(),
      name: z.string().optional(),
    }).optional(),
  }).optional(),
})

const statusSchema = z.object({
  id: z.string(),
  status: z.string(),
  timestamp: z.string().optional(),
  recipient_id: z.string().optional(),
})

const changeSchema = z.object({
  field: z.string(),
  value: z.object({
    messaging_product: z.string().optional(),
    metadata: metadataSchema.optional(),
    contacts: z.array(contactSchema).optional(),
    messages: z.array(messageSchema).optional(),
    statuses: z.array(statusSchema).optional(),
  }),
})

export const webhookPayloadSchema = z.object({
  object: z.string(),
  entry: z.array(
    z.object({
      id: z.string(),
      changes: z.array(changeSchema).optional(),
    }),
  ),
})

export type WebhookPayload = z.infer<typeof webhookPayloadSchema>
export type InboundMessage = z.infer<typeof messageSchema>

/** Our `message_kind` enum values. */
const KNOWN_KINDS = new Set([
  'text',
  'image',
  'audio',
  'video',
  'document',
  'sticker',
  'location',
  'contacts',
  'interactive',
  'template',
  'system',
])

/**
 * Anything we do not recognise becomes `unsupported` — stored and acknowledged
 * honestly, never silently dropped. A reaction, an order or a button reply is
 * a real customer action even when we cannot interpret it yet.
 */
export function toMessageKind(providerType: string): string {
  return KNOWN_KINDS.has(providerType) ? providerType : 'unsupported'
}

/** Meta sends Unix seconds as a string. */
export function toDate(unixSeconds: string): Date {
  return new Date(Number(unixSeconds) * 1000)
}

/**
 * The text of an inbound message, including a tapped button.
 *
 * A tap becomes words so the rest of the system stays unchanged: the turn, the
 * transcript, the extraction and the inbox all work on sentences, and a tap
 * then reads in the history exactly as a typed answer would. Without this a
 * button reply arrives with no body at all and is held for a person — the
 * customer answers the question they were asked and the conversation stops.
 */
export function toMessageBody(message: InboundMessage): string | null {
  if (message.text?.body !== undefined) return message.text.body

  const tapped = message.interactive?.button_reply ?? message.interactive?.list_reply
  if (tapped !== undefined) return meaningOfButton(tapped.id, tapped.title)

  /**
   * A car chosen inside a Flow is the same answer as a car chosen from a list,
   * so it becomes the same sentence. A reply we cannot read returns null and
   * is held for a person, which is the right outcome: the customer definitely
   * chose something and guessing which car would be worse than asking.
   */
  const flow = message.interactive?.nfm_reply
  if (flow !== undefined) {
    const car = carChosenInFlow(flow.response_json)
    return car === null ? null : meaningOfButton(`${VEHICLE_ROW}${car}`, car)
  }

  return null
}

/**
 * A tapped button is a text message as far as everything downstream is
 * concerned. Meta types it `interactive`, which would otherwise route it to the
 * non-text path and hold it.
 */
export function toInboundKind(message: InboundMessage): string {
  const tapped = message.interactive?.button_reply ?? message.interactive?.list_reply
  if (tapped !== undefined) return 'text'
  // A finished Flow too, for the same reason: it is an answer to a question
  // the agent asked, and the non-text path would hold it for a person.
  if (message.interactive?.nfm_reply !== undefined) return 'text'
  return toMessageKind(message.type)
}

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

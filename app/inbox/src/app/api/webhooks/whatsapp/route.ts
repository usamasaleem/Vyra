import { queryRunner } from '@/lib/db'
import { serverEnv } from '@/lib/env'
import { applyMessageStatus, storeInboundEventOnly, storeInboundMessage } from '@/lib/whatsapp/ingest'
import { toDate, toMessageKind, webhookPayloadSchema } from '@/lib/whatsapp/payload'
import { isValidSignature, isValidVerifyToken } from '@/lib/whatsapp/signature'

/**
 * No route segment config on purpose.
 *
 * Next 16 does not cache route handlers by default, so `force-dynamic` would be
 * redundant, and `runtime` is to be removed from route files now that the Edge
 * runtime is deprecated. Both were reflexes from an older Next.
 */

const forbidden = () => new Response('Forbidden', { status: 403 })
const log = (fields: Record<string, unknown>) => console.log(JSON.stringify(fields))

/**
 * Build plan step 6 — the subscription verification challenge.
 *
 * Meta calls this once when the callback URL is saved. Echoing `hub.challenge`
 * proves we control the endpoint. Passing it is not an end-to-end message test
 * (section 18.5): it proves only that this URL answered.
 */
export function GET(request: Request): Response {
  const params = new URL(request.url).searchParams
  const mode = params.get('hub.mode')
  const token = params.get('hub.verify_token')
  const challenge = params.get('hub.challenge')

  if (mode !== 'subscribe' || token === null || challenge === null) return forbidden()
  if (!isValidVerifyToken(token, serverEnv().WHATSAPP_VERIFY_TOKEN)) return forbidden()

  return new Response(challenge, {
    status: 200,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  })
}

/**
 * Build plan steps 7 and 8 — authenticated intake, stored before acknowledged.
 *
 * Read the body as bytes BEFORE parsing. `request.json()` here would consume
 * the stream and leave nothing to verify the HMAC against.
 *
 * The contract with Meta is the important part: a 200 means "this is durably
 * ours". So every write must succeed before we return one. If storage fails we
 * return 500, Meta retries, and the deduplication constraints make the retry
 * harmless. Acknowledging a message we failed to store would lose it for good —
 * Meta does not send it twice on request.
 */
/**
 * The pointer to the file, not the file.
 *
 * This used to store `{ type: 'audio' }` and nothing else, which named the
 * problem without keeping the one thing needed to solve it: a customer sent a
 * voice note, the inbox said "audio message — needs a person", and there was no
 * way for that person to hear it. The id was in the webhook the whole time.
 *
 * Section 18.13 keeps the bytes out of the database — media lives with the
 * provider and is fetched, with credentials, when someone asks for it. What is
 * stored is the id, the mime type, and whether it was recorded as a voice note
 * rather than attached as a file, because a salesperson reads those
 * differently.
 *
 * Meta's `url` is deliberately not stored: it expires within minutes and a
 * stale link that looks live is worse than no link.
 */
function mediaPointer(message: {
  type: string
  audio?: { id?: string; mime_type?: string; voice?: boolean }
  image?: { id?: string; mime_type?: string; caption?: string }
  video?: { id?: string; mime_type?: string; caption?: string }
  document?: { id?: string; mime_type?: string; filename?: string }
  sticker?: { id?: string; mime_type?: string }
}): Record<string, unknown> | null {
  if (message.type === 'text') return null

  const part =
    message.audio ?? message.image ?? message.video ?? message.document ?? message.sticker

  const pointer: Record<string, unknown> = { type: message.type }
  if (part?.id !== undefined) pointer['mediaId'] = part.id
  if (part?.mime_type !== undefined) pointer['mimeType'] = part.mime_type
  // A voice note and an attached audio file read differently to a salesperson.
  if (message.audio?.voice === true) pointer['voiceNote'] = true
  if (message.document?.filename !== undefined) pointer['filename'] = message.document.filename

  const caption = message.image?.caption ?? message.video?.caption
  if (caption !== undefined) pointer['caption'] = caption

  return pointer
}

export async function POST(request: Request): Promise<Response> {
  const rawBody = Buffer.from(await request.arrayBuffer())

  const valid = isValidSignature({
    rawBody,
    header: request.headers.get('x-hub-signature-256'),
    appSecret: serverEnv().WHATSAPP_APP_SECRET,
  })
  if (!valid) return forbidden()

  let payload: unknown
  try {
    payload = JSON.parse(rawBody.toString('utf8'))
  } catch {
    // Malformed JSON will never become valid. Retrying it would loop forever,
    // so this is one of the few cases where dropping is the right answer.
    log({ event: 'whatsapp.webhook.unparseable', bytes: rawBody.byteLength })
    return new Response(null, { status: 200 })
  }

  const parsed = webhookPayloadSchema.safeParse(payload)
  if (!parsed.success) {
    log({ event: 'whatsapp.webhook.unrecognised_shape', bytes: rawBody.byteLength })
    return new Response(null, { status: 200 })
  }

  const run = queryRunner()
  const stored: Array<Record<string, unknown>> = []

  try {
    for (const entry of parsed.data.entry) {
      for (const change of entry.changes ?? []) {
        const phoneNumberId = change.value.metadata?.phone_number_id
        if (phoneNumberId === undefined) continue

        const profileByWaId = new Map(
          (change.value.contacts ?? []).map((c) => [c.wa_id, c.profile?.name ?? null]),
        )

        for (const message of change.value.messages ?? []) {
          const outcome = await storeInboundMessage(run, {
            phoneNumberId,
            // Meta sends no webhook-level event id, so the message id is the
            // deduplication key. Confirmed against a live payload.
            providerEventKey: `message:${message.id}`,
            rawPayload: payload,
            waId: message.from,
            profileName: profileByWaId.get(message.from) ?? null,
            providerMessageId: message.id,
            kind: toMessageKind(message.type),
            body: message.text?.body ?? null,
            media: mediaPointer(message),
            sentAt: toDate(message.timestamp),
          })
          stored.push({ kind: toMessageKind(message.type), ...outcome })
        }

        for (const status of change.value.statuses ?? []) {
          const outcome = await storeInboundEventOnly(run, {
            phoneNumberId,
            providerEventKey: `status:${status.id}:${status.status}`,
            rawPayload: payload,
          })
          // Apply it even when the event is a duplicate: the receipt is
          // idempotent and a redelivery must still be able to move a message
          // forward if the first attempt raced with the send.
          const applied = await applyMessageStatus(run, {
            providerMessageId: status.id,
            status: status.status,
            phoneNumberId,
          })
          stored.push({ kind: 'status', status: status.status, ...outcome, ...applied })
        }
      }
    }
  } catch (error) {
    // Do NOT acknowledge. Meta retries; the unique constraints absorb it.
    log({
      event: 'whatsapp.webhook.store_failed',
      error: error instanceof Error ? error.message : String(error),
    })
    return new Response('Storage failed', { status: 500 })
  }

  log({ event: 'whatsapp.webhook.stored', count: stored.length, results: stored })
  return new Response(null, { status: 200 })
}

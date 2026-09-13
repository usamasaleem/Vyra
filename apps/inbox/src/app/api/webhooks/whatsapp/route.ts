import { serverEnv } from '@/lib/env'
import { isValidSignature, isValidVerifyToken } from '@/lib/whatsapp/signature'

/**
 * No route segment config on purpose.
 *
 * Next 16 does not cache route handlers by default, so `force-dynamic` would be
 * redundant, and `runtime` is to be removed from route files now that the Edge
 * runtime is deprecated. Both were reflexes from an older Next.
 */

const forbidden = () => new Response('Forbidden', { status: 403 })

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
 * Build plan step 7 — authenticated event intake.
 *
 * Read the body as bytes BEFORE parsing. `request.json()` here would consume
 * the stream and leave nothing to verify the HMAC against.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * INCOMPLETE — step 8 (save before acknowledging) is not built.
 *
 * This handler currently returns 200 without storing anything, which is
 * precisely the failure section 18.4 warns about: an acknowledgement tells
 * Meta the event is safely ours, and a message dropped after that is gone for
 * good. Acceptable only because this endpoint receives no real traffic yet.
 *
 * Do not point Meta at this URL until the durable write lands.
 * ─────────────────────────────────────────────────────────────────────────
 */
export async function POST(request: Request): Promise<Response> {
  const rawBody = Buffer.from(await request.arrayBuffer())

  const valid = isValidSignature({
    rawBody,
    header: request.headers.get('x-hub-signature-256'),
    appSecret: serverEnv().WHATSAPP_APP_SECRET,
  })
  if (!valid) return forbidden()

  // TODO(step 8): resolve the operator from the receiving phone_number_id,
  // then write inbound_event + dedupe row + outbox row in ONE transaction and
  // acknowledge only after it commits.
  console.log(
    JSON.stringify({
      event: 'whatsapp.webhook.received',
      bytes: rawBody.byteLength,
      stored: false,
    }),
  )

  return new Response(null, { status: 200 })
}

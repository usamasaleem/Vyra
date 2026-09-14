import { NextResponse } from 'next/server'
import { requireActor } from '@/lib/auth'
import { queryRunner } from '@/lib/db'

/**
 * Playing a voice note a customer sent.
 *
 * WhatsApp media lives with Meta. Section 18.13 keeps it there — the bytes are
 * not copied into the database, and the URL Meta returns expires within
 * minutes, so it cannot be stored and handed out later either. That leaves one
 * honest option: the staff inbox fetches it on demand, with the operator's
 * credentials, and streams it to a salesperson who is allowed to hear it.
 *
 * Two things make this safe rather than a proxy for anything Meta will serve:
 *
 * The media id is never taken from the request. The caller names a *message*,
 * and the id comes from that message's row — so a staff member cannot fetch
 * arbitrary media by guessing ids, only what is attached to a conversation
 * their operator owns.
 *
 * The operator scope is checked in the query, not assumed from the session.
 * Section 18.7: a browser-supplied id is a requested scope, never proof.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ messageId: string }> },
) {
  const actor = await requireActor()
  const { messageId } = await context.params

  const run = queryRunner()
  const rows = await run(
    `select m.media, m.kind
     from messages m
     where m.id = $1 and m.operator_id = $2 and m.direction = 'inbound'`,
    [messageId, actor.operatorId],
  )

  const row = rows[0]
  // Not found rather than forbidden: a different answer would confirm that a
  // message id exists under another operator.
  if (row === undefined) return new NextResponse('Not found', { status: 404 })

  const media = (row['media'] ?? {}) as { mediaId?: string; mimeType?: string }
  if (media.mediaId === undefined) {
    /**
     * Messages received before the pointer was stored. The webhook kept only
     * `{type: 'audio'}`, so the file is unreachable — though the id is still in
     * that event's raw payload, which is what makes a backfill possible.
     */
    return new NextResponse(
      'This message was received before media pointers were stored, so it cannot be played.',
      { status: 410 },
    )
  }

  const apiVersion = process.env['WHATSAPP_API_VERSION'] ?? 'v26.0'
  const token = process.env['WHATSAPP_ACCESS_TOKEN']
  if (token === undefined) return new NextResponse('Media is not configured', { status: 503 })

  // Two hops: the id resolves to a short-lived URL, and that URL needs the same
  // bearer token. Neither is something a browser can do on its own.
  const lookup = await fetch(`https://graph.facebook.com/${apiVersion}/${media.mediaId}`, {
    headers: { authorization: `Bearer ${token}` },
  })
  if (!lookup.ok) {
    return new NextResponse(`Could not resolve media (${lookup.status})`, { status: 502 })
  }
  const { url } = (await lookup.json()) as { url?: string }
  if (url === undefined) return new NextResponse('Media has no url', { status: 502 })

  const file = await fetch(url, { headers: { authorization: `Bearer ${token}` } })
  if (!file.ok || file.body === null) {
    return new NextResponse(`Could not fetch media (${file.status})`, { status: 502 })
  }

  return new NextResponse(file.body, {
    headers: {
      'content-type': media.mimeType ?? file.headers.get('content-type') ?? 'application/octet-stream',
      // Never cached by a shared cache: this is one operator's customer audio,
      // fetched with their credentials.
      'cache-control': 'private, no-store',
    },
  })
}

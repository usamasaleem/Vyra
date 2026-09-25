import { photoAsWords, type PhotoReader } from '@vyra/agent'
import { recordPhotoDescription, type QueryRunner } from '@vyra/db'
import type { WhatsAppClient } from './whatsapp/client.js'

/**
 * A photo becomes words before anything decides what to do with it — the same
 * move as a voice note.
 *
 * A photo that belongs to a booking is still filed as a document: that check
 * runs on the kind of message, not its text, and happens first. Every other
 * photo is answered by the agent from the description instead of going to a
 * person. Any failure — no reader, no media id, a download that fails, an
 * unreadable image — leaves the body empty, and the message goes to a person
 * exactly as before.
 */
export async function describePhoto(deps: {
  run: QueryRunner
  whatsapp: WhatsAppClient
  reader: PhotoReader | null
  messageId: unknown
  log: (fields: Record<string, unknown>) => void
}): Promise<boolean> {
  if (deps.reader === null || typeof deps.messageId !== 'string') return false

  const [row] = await deps.run(
    `select id, operator_id, media from messages
     where id = $1 and direction = 'inbound' and kind = 'image' and body is null`,
    [deps.messageId],
  )
  if (row === undefined) return false

  const media = (row['media'] ?? {}) as Record<string, unknown>
  const mediaId = media['mediaId']
  if (typeof mediaId !== 'string') return false

  const began = Date.now()
  const file = await deps.whatsapp.fetchMedia({ mediaId })
  if (file === null) {
    deps.log({ event: 'photo.download_failed', message: deps.messageId })
    return false
  }
  const description = await deps.reader({ bytes: file.bytes, mimeType: file.mimeType })
  if (description === null) {
    deps.log({ event: 'photo.unreadable', message: deps.messageId, mimeType: file.mimeType })
    return false
  }

  const caption = typeof media['caption'] === 'string' ? media['caption'] : null
  const { recorded } = await recordPhotoDescription(deps.run, {
    messageId: row['id'] as string,
    operatorId: row['operator_id'] as string,
    text: photoAsWords(description, caption),
  })
  // Not the description: it is about a customer's photo, and it is in the
  // conversation where a salesperson can read it in context.
  deps.log({ event: 'photo.described', message: deps.messageId, ms: Date.now() - began, recorded })
  return recorded
}

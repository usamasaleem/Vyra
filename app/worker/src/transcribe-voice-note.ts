import { recordTranscript, type QueryRunner } from '@vyra/db'
import type { Transcriber } from '@vyra/agent'
import type { WhatsAppClient } from './whatsapp/client.js'

/**
 * A voice note, turned into words before anything decides what to do with it.
 *
 * Every step is allowed to fail and every failure means the same thing: the
 * body stays null, and the message routes to a person exactly as voice notes
 * always have. There is no version of this where a guess beats a handover —
 * a customer saying "I've crashed the Huracán" must not become a sales reply
 * because a transcript was half right.
 *
 * The media id is read from `messages.media`, which until today never
 * contained one: the webhook schema stripped `audio` before the pointer that
 * captures it ever ran, so every voice note in the database is a pointer to
 * nothing.
 */
export async function transcribeVoiceNote(deps: {
  run: QueryRunner
  whatsapp: WhatsAppClient
  transcriber: Transcriber | null
  messageId: unknown
  log: (fields: Record<string, unknown>) => void
}): Promise<boolean> {
  if (deps.transcriber === null) return false
  if (typeof deps.messageId !== 'string') return false

  const rows = await deps.run(
    `select m.id, m.operator_id, m.media
     from messages m
     where m.id = $1 and m.direction = 'inbound' and m.kind = 'audio' and m.body is null`,
    [deps.messageId],
  )
  const row = rows[0]
  if (row === undefined) return false

  const media = (row['media'] ?? {}) as Record<string, unknown>
  const mediaId = media['mediaId']
  if (typeof mediaId !== 'string') {
    deps.log({ event: 'transcribe.no_media_id', message: deps.messageId })
    return false
  }

  const file = await deps.whatsapp.fetchMedia({ mediaId })
  if (file === null) {
    deps.log({ event: 'transcribe.download_failed', message: deps.messageId })
    return false
  }

  const began = Date.now()
  const text = await deps.transcriber({ bytes: file.bytes, mimeType: file.mimeType })
  if (text === null) {
    deps.log({
      event: 'transcribe.unreadable',
      message: deps.messageId,
      mimeType: file.mimeType,
      bytes: file.bytes.byteLength,
    })
    return false
  }

  const { recorded } = await recordTranscript(deps.run, {
    messageId: row['id'] as string,
    operatorId: row['operator_id'] as string,
    text,
  })

  deps.log({
    event: 'transcribe.done',
    message: deps.messageId,
    ms: Date.now() - began,
    bytes: file.bytes.byteLength,
    characters: text.length,
    // Not the transcript. It is a customer speaking, and the words are in the
    // conversation where a salesperson can read them in context.
    recorded,
  })
  return recorded
}

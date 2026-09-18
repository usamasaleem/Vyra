import type { QueryRunner } from '../runner.js'

/**
 * What a voice note said, as far as a machine could tell.
 *
 * Written into `body` so that everything downstream keeps working on words —
 * the turn, the transcript, the extraction, the inbox. The alternative is a
 * second field threaded through every one of them, and a transcript nothing
 * reads is the shape of failure this project keeps producing.
 *
 * `kind` stays `audio`. It is still a voice note, a salesperson looking at the
 * thread should see that it was spoken rather than typed, and the model is
 * told so too — a transcript is a reading of what somebody said, not a record
 * of it, and "Huracán" and "hurricane" are one bad second apart.
 *
 * Only ever fills an empty body. A retried job must not overwrite a
 * transcription that already happened, and nothing here should be able to
 * rewrite something a customer actually typed.
 */
export async function recordTranscript(
  run: QueryRunner,
  input: { messageId: string; operatorId: string; text: string },
): Promise<{ recorded: boolean }> {
  const rows = await run(
    `update messages
     set body = $3, media = coalesce(media, '{}'::jsonb) || jsonb_build_object(
           'transcribed', true,
           'transcribedAt', to_jsonb(now())
         )
     where id = $1 and operator_id = $2 and direction = 'inbound'
       and kind = 'audio' and body is null
     returning id`,
    [input.messageId, input.operatorId, input.text],
  )
  return { recorded: rows.length > 0 }
}

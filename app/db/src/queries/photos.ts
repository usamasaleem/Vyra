import type { QueryRunner } from '../runner.js'

/**
 * A photograph of the car the agent just described.
 *
 * Looked up here rather than returned by the search tool, deliberately. A URL
 * in a tool result is a URL the model can paste into a reply, and a link
 * arriving as text in a WhatsApp message is both ugly and a way for an
 * internal address to reach a customer. The model never sees it; the worker
 * attaches it on the way out.
 *
 * Matched on make and model because that is what the tool result carries — the
 * fleet result deliberately holds no identifier, for the same reason.
 */
export async function findVehiclePhoto(
  run: QueryRunner,
  input: { operatorId: string; make: string; model: string },
): Promise<string | null> {
  const rows = await run(
    `select photo_urls from vehicles
     where operator_id = $1 and active and provenance = 'operator_confirmed'
       and make = $2 and model = $3
       and photo_urls is not null and jsonb_array_length(photo_urls) > 0
     limit 2`,
    [input.operatorId, input.make, input.model],
  )

  // Two cars of the same make and model is a real fleet shape, and there is no
  // way to tell from here which one the agent meant. Showing the wrong car's
  // photograph is worse than showing none.
  if (rows.length !== 1) return null

  const urls = rows[0]!['photo_urls'] as string[] | null
  const first = urls?.[0]
  return typeof first === 'string' && first.startsWith('https://') ? first : null
}

/**
 * True when this conversation has already been sent this photograph.
 *
 * A customer who asks three questions about the same car should see it once.
 * Repeating the picture on every reply is what a bot does.
 */
export async function photoAlreadySent(
  run: QueryRunner,
  input: { conversationId: string; operatorId: string; url: string },
): Promise<boolean> {
  const rows = await run(
    `select 1 from messages
     where conversation_id = $1 and operator_id = $2 and reply_image_url = $3
     limit 1`,
    [input.conversationId, input.operatorId, input.url],
  )
  return rows.length > 0
}

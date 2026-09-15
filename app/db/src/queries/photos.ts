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
       -- Type only. jsonb_array_length raises on anything that is not an
       -- array, and writing the type check beside it in an AND does not save
       -- you: SQL does not promise to evaluate conditions in the order they
       -- are written, and the planner is free to measure before it checks.
       -- The first version of this guard was exactly that, and the test that
       -- reproduced the production failure went on failing.
       --
       -- So the shape is filtered here and the contents are judged in
       -- JavaScript, where the order is mine.
       and jsonb_typeof(photo_urls) = 'array'
     limit 2`,
    [input.operatorId, input.make, input.model],
  )

  // Two cars of the same make and model is a real fleet shape, and there is no
  // way to tell from here which one the agent meant. Showing the wrong car's
  // photograph is worse than showing none.
  if (rows.length !== 1) return null

  // Defensive on the way out too. Whatever is in the column, the only thing
  // that leaves this function is an https URL or nothing.
  const urls = rows[0]!['photo_urls']
  if (!Array.isArray(urls) || urls.length === 0) return null
  const first = urls[0]
  return typeof first === 'string' && first.startsWith('https://') ? first : null
}

/**
 * Every photograph of the car, in the order the operator listed them.
 *
 * The same lookup as findVehiclePhoto and the same refusals: one car only, https
 * only, and nothing at all when two cars share a make and model. Capped by the
 * caller rather than here, because how many pictures is a judgement about
 * conversation rather than about data.
 */
export async function findVehiclePhotos(
  run: QueryRunner,
  input: { operatorId: string; make: string; model: string },
): Promise<string[]> {
  const rows = await run(
    `select photo_urls from vehicles
     where operator_id = $1 and active and provenance = 'operator_confirmed'
       and make = $2 and model = $3
       and jsonb_typeof(photo_urls) = 'array'
     limit 2`,
    [input.operatorId, input.make, input.model],
  )
  if (rows.length !== 1) return []

  const urls = rows[0]!['photo_urls']
  if (!Array.isArray(urls)) return []
  return urls.filter((u): u is string => typeof u === 'string' && u.startsWith('https://'))
}

/**
 * Every photograph this conversation has already been sent.
 *
 * A customer who asks three questions about the same car should see it once,
 * and repeating a picture on every reply is what a bot does. But when they ask
 * to see more, the interesting question is not "have we sent any" — it is
 * which ones they have not seen yet, so a second request shows something new
 * rather than the same shot again.
 */
export async function photosSentIn(
  run: QueryRunner,
  input: { conversationId: string; operatorId: string },
): Promise<Set<string>> {
  const rows = await run(
    `select distinct reply_image_url from messages
     where conversation_id = $1 and operator_id = $2 and reply_image_url is not null`,
    [input.conversationId, input.operatorId],
  )
  return new Set(rows.map((r) => r['reply_image_url'] as string))
}

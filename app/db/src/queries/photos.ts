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
export type VehicleImages = {
  /** Every photograph, in the order the operator listed them. */
  photos: string[]
  /**
   * One image holding several of them, when there are several.
   *
   * Preferred over sending them one after another: WhatsApp has no album for an
   * API message, so three photographs are three notifications, and a customer
   * who asked to see a car gets a single block instead.
   */
  collage: string | null
}

export async function findVehicleImages(
  run: QueryRunner,
  input: { operatorId: string; make: string; model: string },
): Promise<VehicleImages> {
  const rows = await run(
    `select photo_urls, collage_url from vehicles
     where operator_id = $1 and active and provenance = 'operator_confirmed'
       and make = $2 and model = $3
       and jsonb_typeof(photo_urls) = 'array'
     limit 2`,
    [input.operatorId, input.make, input.model],
  )
  if (rows.length !== 1) return { photos: [], collage: null }

  const stored = rows[0]!['photo_urls']
  const photos = Array.isArray(stored)
    ? stored.filter((u): u is string => typeof u === 'string' && u.startsWith('https://'))
    : []

  const collage = rows[0]!['collage_url']
  return {
    photos,
    collage: typeof collage === 'string' && collage.startsWith('https://') && photos.length >= 2
      ? collage
      : null,
  }
}

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

/**
 * Which cars this customer has already been shown, and when.
 *
 * `photosSentIn` answers "has this URL gone out", which is what the once-only
 * rule needs. This answers the question the model needs, which is a different
 * one: what does this customer already have. Asked "can you show me the
 * lambo?" after four photographs of it were sent that morning, the right reply
 * mentions them. The model could not, because nothing told it.
 *
 * Matched two ways because photographs go out two ways: an individual picture
 * is one of the vehicle's own photo_urls, and a composite is served from a URL
 * carrying the vehicle id. jsonb_exists rather than the `?` operator so the
 * statement carries no character a driver might read as a placeholder.
 */
export type PhotosShown = {
  make: string
  model: string
  sent: number
  lastSentAt: Date
  /** The message that carried the most recent one, so a reply can quote it. */
  lastMessageId: string
}

export async function photosShownIn(
  run: QueryRunner,
  input: { conversationId: string; operatorId: string },
): Promise<PhotosShown[]> {
  const rows = await run(
    `select v.make, v.model, count(*)::int as sent, max(m.created_at) as last_sent_at,
            (array_agg(m.id order by m.created_at desc))[1] as last_message_id
     from messages m
     join vehicles v
       on v.operator_id = m.operator_id
      and (
        (jsonb_typeof(v.photo_urls) = 'array' and jsonb_exists(v.photo_urls, m.reply_image_url))
        or position('/fleet-photo/' || v.id::text in m.reply_image_url) > 0
      )
     where m.conversation_id = $1 and m.operator_id = $2 and m.reply_image_url is not null
     group by v.make, v.model
     order by max(m.created_at) desc`,
    [input.conversationId, input.operatorId],
  )
  return rows.map((r) => ({
    make: r['make'] as string,
    model: r['model'] as string,
    sent: Number(r['sent'] ?? 0),
    lastSentAt: new Date(r['last_sent_at'] as string),
    lastMessageId: r['last_message_id'] as string,
  }))
}

/**
 * One photograph of each car, for showing a fleet rather than a car.
 *
 * "What have you got?" used to send a tappable list of names and no pictures at
 * all: the photo path requires exactly one car, because a reply about three of
 * them has no single picture. True, and it answered the wrong question — the
 * answer is not one picture, it is one picture each.
 *
 * Deliberately narrow. The first photograph, the name, and nothing else: no
 * rate, no availability, no description. A car that has no photograph is left
 * out rather than represented by a gap, and the reply still names it.
 *
 * The same refusals as findVehiclePhoto, for the same reasons: confirmed and
 * active cars only, https only, and a make and model shared by two vehicles
 * yields nothing, because there is no way to tell from here which one was
 * meant and the wrong car is worse than no car.
 */
export type FleetCard = {
  make: string
  model: string
  variant: string | null
  colour: string
  photoUrl: string
}

export async function findFleetShowcase(
  run: QueryRunner,
  input: { operatorId: string; cars: ReadonlyArray<{ make: string; model: string }> },
): Promise<FleetCard[]> {
  if (input.cars.length === 0) return []

  const rows = await run(
    `select make, model, variant, colour, photo_urls,
            count(*) over (partition by make, model)::int as same_name
     from vehicles
     where operator_id = $1 and active and provenance = 'operator_confirmed'
       and jsonb_typeof(photo_urls) = 'array'
       -- Ordinary text comparison rather than the folded one: these names came
       -- from a search result this turn, so they are already the database's own
       -- spelling and an accent cannot have gone missing on the way.
       and (make || ' ' || model) = any($2::text[])`,
    [input.operatorId, input.cars.map((c) => `${c.make} ${c.model}`)],
  )

  const cards: FleetCard[] = []
  for (const row of rows) {
    if (Number(row['same_name']) !== 1) continue
    const urls = row['photo_urls']
    if (!Array.isArray(urls)) continue
    const first = urls.find((u): u is string => typeof u === 'string' && u.startsWith('https://'))
    if (first === undefined) continue
    cards.push({
      make: row['make'] as string,
      model: row['model'] as string,
      variant: (row['variant'] as string) ?? null,
      colour: row['colour'] as string,
      photoUrl: first,
    })
  }

  // The order the cars were searched in, so the pictures match the reply.
  const order = new Map(input.cars.map((c, i) => [`${c.make} ${c.model}`, i]))
  return cards.sort(
    (a, b) => (order.get(`${a.make} ${a.model}`) ?? 0) - (order.get(`${b.make} ${b.model}`) ?? 0),
  )
}

import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  findFleetShowcase, findVehiclePhoto, findVehiclePhotos, photosSentIn, photosShownIn,
} from '../src/queries/photos.ts'
import type { QueryRunner } from '../src/runner.ts'

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations')
const OP = '11111111-1111-1111-1111-111111111111'
const ACCOUNT = '33333333-3333-3333-3333-333333333333'
const CONTACT = '55555555-5555-5555-5555-555555555555'
const CONV = '66666666-6666-6666-6666-666666666666'
const PHOTO = 'https://example.com/huracan-1.jpg'

let db: PGlite
let run: QueryRunner

beforeEach(async () => {
  db = await PGlite.create()
  run = async (t, p) => (await db.query(t, p)).rows as Array<Record<string, unknown>>
  for (const f of readdirSync(migrationsDir).filter((n) => n.endsWith('.sql')).sort()) {
    await db.exec(readFileSync(join(migrationsDir, f), 'utf8'))
  }
  await db.exec(`
    insert into operators (id, name, timezone) values ('${OP}', 'Vyra Pilot', 'Asia/Dubai');
    insert into whatsapp_accounts (id, operator_id, provider_account_id, phone_number_id)
    values ('${ACCOUNT}', '${OP}', 'waba', '111');
    insert into contacts (id, operator_id, channel_identifier) values ('${CONTACT}', '${OP}', '9715001');
    insert into conversations (id, operator_id, contact_id, whatsapp_account_id)
    values ('${CONV}', '${OP}', '${CONTACT}', '${ACCOUNT}');
  `)
})

const addCar = (overrides: Record<string, unknown> = {}) => {
  const v = { make: 'Lamborghini', model: 'Huracán', plate: `P${Math.random()}`,
              chassis: `V${Math.random()}`, photos: [PHOTO], active: true, ...overrides }
  return run(
    `insert into vehicles (operator_id, make, model, year, colour, category, plate,
                           chassis_number, active, provenance, confirmed_by, photo_urls)
     values ($1,$2,$3,2023,'Orange','exotic',$4,$5,$6,'operator_confirmed','Owner',$7::jsonb)`,
    [OP, v.make, v.model, v.plate, v.chassis, v.active,
     v.photos === null ? null : JSON.stringify(v.photos)],
  )
}

describe('findVehiclePhoto', () => {
  it('finds the first photo of the car', async () => {
    await addCar({ photos: [PHOTO, 'https://example.com/huracan-2.jpg'] })
    expect(await findVehiclePhoto(run, { operatorId: OP, make: 'Lamborghini', model: 'Huracán' }))
      .toBe(PHOTO)
  })

  it('returns nothing when the car has none', async () => {
    await addCar({ photos: null })
    expect(await findVehiclePhoto(run, { operatorId: OP, make: 'Lamborghini', model: 'Huracán' }))
      .toBeNull()
  })

  /**
   * Two cars of the same make and model is a real fleet shape, and nothing here
   * can tell which one the agent meant. The wrong car's photograph is worse
   * than none.
   */
  it('refuses when two cars share a make and model', async () => {
    await addCar()
    await addCar({ photos: ['https://example.com/other.jpg'] })
    expect(await findVehiclePhoto(run, { operatorId: OP, make: 'Lamborghini', model: 'Huracán' }))
      .toBeNull()
  })

  it('ignores a car that is off the road', async () => {
    await addCar({ active: false })
    expect(await findVehiclePhoto(run, { operatorId: OP, make: 'Lamborghini', model: 'Huracán' }))
      .toBeNull()
  })

  /** WhatsApp fetches the image itself and will not follow an http link. */
  it('refuses a link WhatsApp cannot fetch', async () => {
    await addCar({ photos: ['http://example.com/insecure.jpg'] })
    expect(await findVehiclePhoto(run, { operatorId: OP, make: 'Lamborghini', model: 'Huracán' }))
      .toBeNull()
  })

  /**
   * The bug this caused in production. A seeding script stored the array as a
   * jsonb *string* containing JSON; jsonb_array_length raised on it; the raise
   * happened inside the turn; the job retried and raised again. A customer got
   * no reply at all because a decoration could not be looked up.
   */
  it('survives a photo field that is not an array', async () => {
    await addCar({ photos: null })
    await run(
      `update vehicles set photo_urls = to_jsonb($1::text) where operator_id = $2`,
      ['["https://example.com/a.jpg"]', OP],
    )

    await expect(
      findVehiclePhoto(run, { operatorId: OP, make: 'Lamborghini', model: 'Huracán' }),
    ).resolves.toBeNull()
  })

  it('survives an array holding something that is not a link', async () => {
    await addCar({ photos: null })
    await run(`update vehicles set photo_urls = '[123]'::jsonb where operator_id = $1`, [OP])

    await expect(
      findVehiclePhoto(run, { operatorId: OP, make: 'Lamborghini', model: 'Huracán' }),
    ).resolves.toBeNull()
  })

  it('belongs to one operator', async () => {
    await addCar()
    expect(await findVehiclePhoto(run, {
      operatorId: '11111111-1111-1111-1111-1111111111bb', make: 'Lamborghini', model: 'Huracán',
    })).toBeNull()
  })
})

describe('photosSentIn', () => {
  const sendWithPhoto = (url: string) =>
    run(
      `insert into messages (operator_id, conversation_id, direction, kind, body, provider_id, reply_image_url)
       values ($1, $2, 'outbound', 'text', 'Here she is.', $3, $4)`,
      [OP, CONV, `wamid.${Math.random()}`, url],
    )

  it('is empty before anything has been sent', async () => {
    expect(await photosSentIn(run, { conversationId: CONV, operatorId: OP })).toEqual(new Set())
  })

  /**
   * Which ones, not whether any. A customer asking to see more should get
   * something new rather than the same shot again.
   */
  it('names exactly what this conversation has seen', async () => {
    await sendWithPhoto(PHOTO)
    await sendWithPhoto('https://example.com/side.jpg')
    await sendWithPhoto(PHOTO)

    expect(await photosSentIn(run, { conversationId: CONV, operatorId: OP }))
      .toEqual(new Set([PHOTO, 'https://example.com/side.jpg']))
  })
})

describe('findVehiclePhotos', () => {
  it('returns them in the order the operator listed them', async () => {
    await addCar({ photos: [
      'https://example.com/front.jpg',
      'https://example.com/side.jpg',
      'https://example.com/interior.jpg',
    ] })

    expect(await findVehiclePhotos(run, { operatorId: OP, make: 'Lamborghini', model: 'Huracán' }))
      .toEqual([
        'https://example.com/front.jpg',
        'https://example.com/side.jpg',
        'https://example.com/interior.jpg',
      ])
  })

  it('drops anything WhatsApp could not fetch', async () => {
    await addCar({ photos: ['https://example.com/ok.jpg', 'http://example.com/no.jpg', 42] })
    expect(await findVehiclePhotos(run, { operatorId: OP, make: 'Lamborghini', model: 'Huracán' }))
      .toEqual(['https://example.com/ok.jpg'])
  })

  /** The same refusals as the single lookup: the wrong car is worse than none. */
  it('refuses when two cars share a make and model', async () => {
    await addCar()
    await addCar({ photos: ['https://example.com/other.jpg'] })
    expect(await findVehiclePhotos(run, { operatorId: OP, make: 'Lamborghini', model: 'Huracán' }))
      .toEqual([])
  })

  it('survives a photo field that is not an array', async () => {
    await addCar({ photos: null })
    await run(`update vehicles set photo_urls = to_jsonb($1::text) where operator_id = $2`,
      ['["https://example.com/a.jpg"]', OP])

    await expect(
      findVehiclePhotos(run, { operatorId: OP, make: 'Lamborghini', model: 'Huracán' }),
    ).resolves.toEqual([])
  })
})

/**
 * What the model needs, which is not what the once-only rule needs.
 *
 * `photosSentIn` answers "has this URL gone out". This answers "what does this
 * customer already have", and its absence is why a reply said "I've attached
 * the photos here" the morning after four of them had already been sent.
 */
describe('photosShownIn', () => {
  const sendWithPhoto = (url: string) =>
    run(
      `insert into messages (operator_id, conversation_id, direction, kind, body, provider_id, reply_image_url)
       values ($1, $2, 'outbound', 'text', '', $3, $4) returning id`,
      [OP, CONV, `wamid.${Math.random()}`, url],
    )

  it('is empty before anything has been shown', async () => {
    await addCar()
    expect(await photosShownIn(run, { conversationId: CONV, operatorId: OP })).toEqual([])
  })

  it('counts what went out, per car, and names when', async () => {
    await addCar({ photos: [PHOTO, 'https://example.com/side.jpg'] })
    await sendWithPhoto(PHOTO)
    await sendWithPhoto('https://example.com/side.jpg')

    const [shown] = await photosShownIn(run, { conversationId: CONV, operatorId: OP })
    expect(shown).toMatchObject({ make: 'Lamborghini', model: 'Huracán', sent: 2 })
    expect(shown!.lastSentAt).toBeInstanceOf(Date)
  })

  /** A composite carries the vehicle id in its URL rather than being one of the photos. */
  it('recognises a collage by the vehicle id in its link', async () => {
    await addCar({ photos: [PHOTO] })
    const [car] = await run(`select id from vehicles`, [])
    await sendWithPhoto(`https://vyra-inbox.netlify.app/api/fleet-photo/${car!['id']}`)

    const [shown] = await photosShownIn(run, { conversationId: CONV, operatorId: OP })
    expect(shown).toMatchObject({ make: 'Lamborghini', sent: 1 })
  })

  /** The message id is what a contextual reply quotes, so it has to be the latest one. */
  it('names the message that carried the most recent photograph', async () => {
    await addCar({ photos: [PHOTO, 'https://example.com/side.jpg'] })
    await sendWithPhoto(PHOTO)
    const [latest] = await sendWithPhoto('https://example.com/side.jpg')

    const [shown] = await photosShownIn(run, { conversationId: CONV, operatorId: OP })
    expect(shown!.lastMessageId).toBe(latest!['id'])
  })

  it('does not report another conversation as already shown', async () => {
    await addCar()
    await sendWithPhoto(PHOTO)
    expect(await photosShownIn(run, {
      conversationId: '99999999-9999-9999-9999-999999999999', operatorId: OP,
    })).toEqual([])
  })
})

/**
 * A line-up rather than a car. "What have you got?" used to send names with no
 * pictures at all, because the photo path wants exactly one vehicle.
 */
describe('findFleetShowcase', () => {
  const CARS = [{ make: 'Lamborghini', model: 'Huracán' }, { make: 'Ferrari', model: '488' }]

  const addFerrari = (photos: string[] | null = ['https://example.com/ferrari.jpg']) =>
    addCar({ make: 'Ferrari', model: '488', photos })

  it('returns one photograph per car, named', async () => {
    await addCar({ photos: [PHOTO, 'https://example.com/huracan-2.jpg'] })
    await addFerrari()

    const cards = await findFleetShowcase(run, { operatorId: OP, cars: CARS })
    expect(cards.map((c) => [c.make, c.model, c.photoUrl])).toEqual([
      ['Lamborghini', 'Huracán', PHOTO],
      ['Ferrari', '488', 'https://example.com/ferrari.jpg'],
    ])
  })

  /** The pictures have to arrive in the order the reply names the cars. */
  it('keeps the order the cars were searched in', async () => {
    await addCar({ photos: [PHOTO] })
    await addFerrari()

    const cards = await findFleetShowcase(run, {
      operatorId: OP,
      cars: [{ make: 'Ferrari', model: '488' }, { make: 'Lamborghini', model: 'Huracán' }],
    })
    expect(cards.map((c) => c.make)).toEqual(['Ferrari', 'Lamborghini'])
  })

  /** A car with no photograph is left out rather than shown as a gap. */
  it('leaves out a car that has no photographs', async () => {
    await addCar({ photos: [PHOTO] })
    await addFerrari([])

    const cards = await findFleetShowcase(run, { operatorId: OP, cars: CARS })
    expect(cards.map((c) => c.make)).toEqual(['Lamborghini'])
  })

  /**
   * Two cars sharing a make and model is a real fleet shape, and there is no
   * way to tell from here which one was meant. The same refusal as the
   * single-car lookup, for the same reason.
   */
  it('shows nothing for a make and model two vehicles share', async () => {
    await addCar({ photos: [PHOTO] })
    await addCar({ photos: ['https://example.com/huracan-other.jpg'] })

    expect(await findFleetShowcase(run, { operatorId: OP, cars: CARS })).toEqual([])
  })

  it('ignores a car that is not active or not confirmed', async () => {
    await addCar({ photos: [PHOTO], active: false })
    expect(await findFleetShowcase(run, { operatorId: OP, cars: CARS })).toEqual([])
  })

  it('refuses anything that is not an https link', async () => {
    await addCar({ photos: ['javascript:alert(1)', PHOTO] })
    const [card] = await findFleetShowcase(run, { operatorId: OP, cars: CARS })
    expect(card!.photoUrl).toBe(PHOTO)
  })

  it('asks for nothing when there are no cars', async () => {
    expect(await findFleetShowcase(run, { operatorId: OP, cars: [] })).toEqual([])
  })
})

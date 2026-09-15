import sharp from 'sharp'
import { queryRunner } from '@/lib/db'

/**
 * Several photographs of a car, laid out as one image.
 *
 * WhatsApp has no album for an API message. The grid a customer sees when a
 * person sends four pictures from the picker is the client grouping a
 * multi-select send, and no integration can produce it — so the only way to put
 * several photographs in one message is to make them one photograph.
 *
 * Public, and it has to be: WhatsApp fetches this URL itself and cannot sign
 * in. What it exposes is marketing photography of cars the operator advertises,
 * behind an unguessable id.
 *
 * It composes only URLs already stored on that vehicle by an administrator, so
 * this is not a fetcher anybody can point at anything. That matters more than
 * it looks: an endpoint that fetches a URL from its own query string is a way
 * into whatever the server can reach.
 */
export const dynamic = 'force-dynamic'

/** Wide enough to read on a phone, small enough to stay well inside 5 MB. */
const WIDTH = 1200
const HEIGHT = 800
const GAP = 8

type Box = { left: number; top: number; width: number; height: number }

/**
 * Where each photograph sits, by how many there are.
 *
 * Two side by side; three as one large and two stacked, which is what a person
 * sending a car does; four as a square. More than four is cropped to four — a
 * fifth thumbnail is too small to show anything.
 */
function layoutFor(count: number): Box[] {
  const halfW = Math.floor((WIDTH - GAP) / 2)
  const halfH = Math.floor((HEIGHT - GAP) / 2)

  if (count === 2) {
    return [
      { left: 0, top: 0, width: halfW, height: HEIGHT },
      { left: halfW + GAP, top: 0, width: WIDTH - halfW - GAP, height: HEIGHT },
    ]
  }
  if (count === 3) {
    return [
      { left: 0, top: 0, width: halfW, height: HEIGHT },
      { left: halfW + GAP, top: 0, width: WIDTH - halfW - GAP, height: halfH },
      { left: halfW + GAP, top: halfH + GAP, width: WIDTH - halfW - GAP, height: HEIGHT - halfH - GAP },
    ]
  }
  return [
    { left: 0, top: 0, width: halfW, height: halfH },
    { left: halfW + GAP, top: 0, width: WIDTH - halfW - GAP, height: halfH },
    { left: 0, top: halfH + GAP, width: halfW, height: HEIGHT - halfH - GAP },
    { left: halfW + GAP, top: halfH + GAP, width: WIDTH - halfW - GAP, height: HEIGHT - halfH - GAP },
  ]
}

async function fetchImage(url: string): Promise<Buffer | null> {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(8000),
      // Some CDNs refuse a request with no user agent, and a refused fetch here
      // would silently produce a gap in the grid.
      headers: { 'user-agent': 'Vyra/1.0 (+https://vyra-inbox.netlify.app)' },
    })
    if (!response.ok) return null
    const type = response.headers.get('content-type') ?? ''
    if (!type.startsWith('image/')) return null
    return Buffer.from(await response.arrayBuffer())
  } catch {
    return null
  }
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ vehicleId: string }> },
) {
  const { vehicleId } = await params

  const rows = await queryRunner()(
    `select photo_urls from vehicles
     where id = $1 and active and jsonb_typeof(photo_urls) = 'array'`,
    [vehicleId],
  )
  const stored = rows[0]?.['photo_urls']
  const urls = (Array.isArray(stored) ? stored : [])
    .filter((u): u is string => typeof u === 'string' && u.startsWith('https://'))
    .slice(0, 4)

  if (urls.length < 2) {
    return new Response('Not enough photographs to compose.', { status: 404 })
  }

  const fetched = (await Promise.all(urls.map(fetchImage)))
    .filter((b): b is Buffer => b !== null)

  if (fetched.length < 2) {
    return new Response('Could not fetch the photographs.', { status: 502 })
  }

  const boxes = layoutFor(fetched.length)
  const tiles = await Promise.all(
    fetched.slice(0, boxes.length).map(async (buffer, index) => {
      const box = boxes[index]!
      // Cover, not contain: a letterboxed car on a black bar looks like a
      // mistake, and every one of these is a wide studio shot that crops well.
      const resized = await sharp(buffer)
        .resize(box.width, box.height, { fit: 'cover', position: 'centre' })
        .toBuffer()
      return { input: resized, left: box.left, top: box.top }
    }),
  )

  const composed = await sharp({
    create: {
      width: WIDTH, height: HEIGHT, channels: 3,
      // White, because every one of these is shot in a white studio and a black
      // gutter would read as a border rather than a gap.
      background: { r: 255, g: 255, b: 255 },
    },
  })
    .composite(tiles)
    .jpeg({ quality: 82 })
    .toBuffer()

  return new Response(new Uint8Array(composed), {
    headers: {
      'content-type': 'image/jpeg',
      // Long, because the photographs behind it change rarely and WhatsApp
      // fetches this on every send. The URL changes when the car does.
      'cache-control': 'public, max-age=86400, s-maxage=604800',
    },
  })
}

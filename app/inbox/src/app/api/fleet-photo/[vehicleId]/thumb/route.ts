import sharp from 'sharp'
import { queryRunner } from '@/lib/db'

/**
 * A single small photograph of one car.
 *
 * Its own path rather than a query string on the composite, which is how it
 * was first written and immediately wrong: Netlify keyed its cache on the path
 * alone, so the first request for a thumbnail poisoned the composite with it.
 * Both returned the same 6932 bytes — a 320-pixel thumbnail served where a
 * 1200-pixel collage belonged, which would have reached customers as the
 * picture of their car.
 *
 * Flows carry their images as base64 inside the message payload, capped at
 * 100KB each, so the thumbnail has to be made somewhere and this is where the
 * image toolchain already lives. The worker fetches this URL and encodes what
 * comes back, rather than growing a native image dependency of its own.
 *
 * 320x214 at quality 72 lands around 7KB for a studio shot — far enough under
 * the cap that a darker or busier photograph cannot creep over it.
 */
const THUMB = { width: 320, height: 214, quality: 72 } as const

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

  /**
   * Privileged and public, for the same reason as the composite beside it:
   * WhatsApp fetches the image and cannot sign in. The vehicle id is the only
   * scope, which is why this returns a photograph and nothing else.
   */
  const rows = await queryRunner()(
    `select photo_urls from vehicles
     where id = $1 and active and jsonb_typeof(photo_urls) = 'array'`,
    [vehicleId],
  )
  const stored = rows[0]?.['photo_urls']
  const first = (Array.isArray(stored) ? stored : [])
    .find((u): u is string => typeof u === 'string' && u.startsWith('https://'))

  if (first === undefined) return new Response('No photographs on file.', { status: 404 })

  const source = await fetchImage(first)
  if (source === null) return new Response('Could not fetch the photograph.', { status: 502 })

  const small = await sharp(source)
    .resize(THUMB.width, THUMB.height, { fit: 'cover', position: 'centre' })
    .jpeg({ quality: THUMB.quality })
    .toBuffer()

  return new Response(new Uint8Array(small), {
    headers: {
      'content-type': 'image/jpeg',
      'cache-control': 'public, max-age=86400, immutable',
    },
  })
}

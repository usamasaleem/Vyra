/**
 * Whether a link WhatsApp is about to fetch will actually arrive as a picture.
 *
 * The inbox checked that a photo link was https and parseable and left the
 * fetching to WhatsApp. That is the shape of failure this project keeps
 * finding: the check was real, it just tested the wrong thing. A photograph
 * that had moved, or sat behind hotlink protection, or was saved as a webp,
 * passed every check and then went out as a message with nothing in it — and
 * the first party to notice was the customer.
 *
 * The fetch stays in the app, because it is I/O. The judgement lives here,
 * because it is a rule, and a rule can be tested against the cases that
 * actually happen.
 */

/**
 * The Cloud API accepts jpeg and png for an image message. Anything else is
 * accepted by this form, stored happily, and dropped at send time.
 */
export const SENDABLE_IMAGE_TYPES = ['image/jpeg', 'image/png']

/** WhatsApp's ceiling for an image message. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024

export type ImageResponseFacts = {
  status: number
  /** The raw header, parameters and all: `image/jpeg; charset=binary`. */
  contentType: string | null
  contentLength: string | null
  /** Set when the size was learned from a ranged request. */
  contentRange: string | null
}

/**
 * The real size of the file.
 *
 * A one-byte ranged request reports `content-length: 1`, which would pass a
 * size check on a 40MB photograph. `content-range: bytes 0-0/41943040` carries
 * the truth after the slash, so it is preferred whenever it is present.
 */
export function imageSizeFrom(facts: ImageResponseFacts): number | null {
  const fromRange = facts.contentRange?.split('/')[1]
  const raw = fromRange !== undefined && fromRange !== '*' ? fromRange : facts.contentLength
  if (raw == null || raw.trim() === '') return null
  const size = Number(raw)
  return Number.isFinite(size) && size >= 0 ? size : null
}

/**
 * What is wrong with this link, as a sentence that follows the URL.
 *
 * Null when nothing is. Phrased as the consequence rather than the symptom —
 * an operator does not need to know what a content type is, they need to know
 * that the customer will get no picture.
 */
export function complaintAboutImage(facts: ImageResponseFacts): string | null {
  // 206 is the ranged fallback answering correctly, not a failure.
  if (facts.status !== 206 && (facts.status < 200 || facts.status >= 300)) {
    return `answered ${facts.status}. WhatsApp will get the same answer and send no picture.`
  }

  /**
   * An absent content type is let through on purpose. Some hosts omit it on a
   * HEAD and serve it correctly on the real GET, and refusing a photograph
   * that works is worse than allowing one that might not.
   */
  const type = (facts.contentType ?? '').split(';')[0]!.trim().toLowerCase()
  if (type !== '' && !SENDABLE_IMAGE_TYPES.includes(type)) {
    return type.startsWith('image/')
      ? `is a ${type.slice('image/'.length)}. WhatsApp sends jpeg and png only.`
      : `is not a picture — the server calls it ${type}.`
  }

  const size = imageSizeFrom(facts)
  if (size !== null && size > MAX_IMAGE_BYTES) {
    return `is ${(size / 1024 / 1024).toFixed(1)}MB. WhatsApp will not send anything over 5MB.`
  }

  return null
}

/**
 * Hosts serving a set of photographs.
 *
 * Small, and the reason is not. The pilot's only photographed car served four
 * images from a competitor's CDN: their bandwidth, their copyright, and their
 * decision whether the link keeps working tomorrow. A textarea of URLs hides
 * that completely once it has been filled in and stopped being read.
 */
export function hostsOf(urls: readonly string[]): string[] {
  const hosts = new Set<string>()
  for (const url of urls) {
    try {
      hosts.add(new URL(url).host)
    } catch {
      // Unparseable links are refused at save time; nothing to report here.
    }
  }
  return [...hosts]
}

import { createHash, createHmac, timingSafeEqual } from 'node:crypto'

const SIGNATURE_PREFIX = 'sha256='
const SHA256_BYTES = 32

/**
 * Verify Meta's `X-Hub-Signature-256` over the untouched request body.
 *
 * The body must be the exact bytes Meta sent. Any parser that touches it first
 * — a JSON body parser, a re-serialisation, a change of whitespace — breaks the
 * HMAC, and the failure looks like a credential problem rather than a parsing
 * one. Section 5 of TECH-STACK.md lists this as the trap most likely to bite.
 *
 * The prototype had no signature verification at all, so this is new.
 */
export function isValidSignature(input: {
  rawBody: Buffer
  header: string | null
  appSecret: string
}): boolean {
  const { rawBody, header, appSecret } = input
  if (header === null || !header.startsWith(SIGNATURE_PREFIX)) return false

  const provided = Buffer.from(header.slice(SIGNATURE_PREFIX.length), 'hex')
  // A malformed hex string decodes to a short buffer, which would make
  // timingSafeEqual throw rather than return false.
  if (provided.length !== SHA256_BYTES) return false

  const expected = createHmac('sha256', appSecret).update(rawBody).digest()
  return timingSafeEqual(provided, expected)
}

/**
 * Compare the subscription verify token without leaking its length or
 * contents through timing. Hashing first makes the comparison fixed-width, so
 * a wrong-length token is rejected the same way a wrong-value one is.
 */
export function isValidVerifyToken(provided: string, expected: string): boolean {
  const a = createHash('sha256').update(provided, 'utf8').digest()
  const b = createHash('sha256').update(expected, 'utf8').digest()
  return timingSafeEqual(a, b)
}

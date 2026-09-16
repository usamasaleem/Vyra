import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

/**
 * Sealing an operator's WhatsApp token before it goes in a table.
 *
 * Multi-tenant sending needs a credential per operator, and a credential per
 * operator means one sitting in a database row. A Meta access token can send
 * messages as that business to anybody, so plaintext is not an option and
 * "the database is private" is not a plan — the same column would be in every
 * backup, every dump, and every screen-share of a query result.
 *
 * AES-256-GCM in Node rather than pgcrypto, for two reasons. The key never
 * reaches the database, so a copy of the data is not a copy of the secret. And
 * PGlite has no pgcrypto, so the alternative would be a security control that
 * no test could exercise.
 *
 * GCM rather than CBC because it authenticates: a ciphertext somebody has
 * edited fails to open rather than decrypting to something.
 *
 * Deliberately NOT exported from this package's index. Client components
 * import the barrel for two lists of strings, and re-exporting this from there
 * pulls node:crypto into the browser bundle — which the Next build refuses,
 * correctly. Import it as '@vyra/contracts/secrets' from server code only.
 */

const ALGORITHM = 'aes-256-gcm'
const IV_BYTES = 12
const KEY_BYTES = 32

export class MissingSecretKeyError extends Error {
  constructor() {
    super(
      'WHATSAPP_TOKEN_KEY is not set, so an operator access token cannot be stored. ' +
      'Generate one with: openssl rand -base64 32',
    )
    this.name = 'MissingSecretKeyError'
  }
}

function keyFrom(material: string | undefined): Buffer {
  if (material === undefined || material.trim() === '') throw new MissingSecretKeyError()
  const key = Buffer.from(material, 'base64')
  if (key.length !== KEY_BYTES) {
    throw new Error(`WHATSAPP_TOKEN_KEY must decode to ${KEY_BYTES} bytes; got ${key.length}.`)
  }
  return key
}

/**
 * iv.ciphertext.tag, base64 each.
 *
 * Self-describing on purpose: a column holding one of these can be read back
 * without a second column saying how, and the shape is obvious enough in a
 * dump that nobody mistakes it for a token they can use.
 */
export function sealSecret(plaintext: string, keyMaterial: string | undefined): string {
  const key = keyFrom(keyMaterial)
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGORITHM, key, iv)
  const sealed = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return [
    iv.toString('base64'),
    sealed.toString('base64'),
    cipher.getAuthTag().toString('base64'),
  ].join('.')
}

/**
 * Null rather than throwing when it cannot be opened.
 *
 * The callers are a worker deciding whether it can send and a page deciding
 * what to show. Neither is improved by an exception: a token that will not
 * open is a number that cannot send, which is a thing to report rather than a
 * crash to recover from.
 */
export function openSecret(sealed: string, keyMaterial: string | undefined): string | null {
  try {
    const key = keyFrom(keyMaterial)
    const [iv, body, tag] = sealed.split('.')
    if (iv === undefined || body === undefined || tag === undefined) return null

    const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(iv, 'base64'))
    decipher.setAuthTag(Buffer.from(tag, 'base64'))
    return Buffer.concat([
      decipher.update(Buffer.from(body, 'base64')),
      decipher.final(),
    ]).toString('utf8')
  } catch {
    return null
  }
}

/**
 * The last four characters, for showing that a token is stored without showing
 * the token. Meta's are long and opaque, so four is enough to tell two apart
 * and far too few to use.
 */
export function secretHint(plaintext: string): string {
  return plaintext.trim().slice(-4)
}

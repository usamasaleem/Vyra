import { describe, expect, it } from 'vitest'
import { MissingSecretKeyError, openSecret, sealSecret, secretHint } from '../src/secrets.ts'

const KEY = Buffer.alloc(32, 7).toString('base64')
const OTHER = Buffer.alloc(32, 9).toString('base64')
const TOKEN = 'EAATLtpAxI3oBST5ILRBYpIKZClpXk3NGQYBPhbAS7hCC'

describe('sealing an operator token', () => {
  it('comes back the same', () => {
    expect(openSecret(sealSecret(TOKEN, KEY), KEY)).toBe(TOKEN)
  })

  /** Otherwise two identical tokens would be visibly identical in a dump. */
  it('looks different every time', () => {
    expect(sealSecret(TOKEN, KEY)).not.toBe(sealSecret(TOKEN, KEY))
  })

  it('will not open with a different key', () => {
    expect(openSecret(sealSecret(TOKEN, KEY), OTHER)).toBeNull()
  })

  /** GCM authenticates, so an edited ciphertext fails rather than decrypting. */
  it('will not open after somebody has edited it', () => {
    const sealed = sealSecret(TOKEN, KEY)
    const [iv, body, tag] = sealed.split('.')
    const tampered = [iv, Buffer.from('nonsense').toString('base64'), tag].join('.')
    expect(openSecret(tampered, KEY)).toBeNull()
  })

  it('will not open something that is not one of these at all', () => {
    expect(openSecret('just a string', KEY)).toBeNull()
    expect(openSecret('', KEY)).toBeNull()
  })

  /**
   * Refusing is the point: the alternative to failing here is storing a
   * sending credential in plaintext because a variable was missing.
   */
  it('refuses to seal anything without a key', () => {
    expect(() => sealSecret(TOKEN, undefined)).toThrow(MissingSecretKeyError)
    expect(() => sealSecret(TOKEN, '   ')).toThrow(MissingSecretKeyError)
  })

  it('refuses a key of the wrong size rather than padding it', () => {
    expect(() => sealSecret(TOKEN, Buffer.alloc(16, 1).toString('base64')))
      .toThrow(/32 bytes/)
  })

  /** A worker that cannot open a token cannot send; that is a report, not a crash. */
  it('says nothing rather than throwing when the key is gone', () => {
    expect(openSecret(sealSecret(TOKEN, KEY), undefined)).toBeNull()
  })

  it('shows enough of a token to tell two apart and not enough to use', () => {
    expect(secretHint(TOKEN)).toBe('7hCC')
  })
})

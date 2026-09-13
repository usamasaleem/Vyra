import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { isValidSignature, isValidVerifyToken } from '../src/lib/whatsapp/signature.ts'

const APP_SECRET = 'test-app-secret'
const sign = (body: Buffer | string, secret = APP_SECRET) =>
  `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`

describe('isValidSignature', () => {
  const body = Buffer.from(JSON.stringify({ object: 'whatsapp_business_account' }))

  it('accepts a signature Meta would send', () => {
    expect(isValidSignature({ rawBody: body, header: sign(body), appSecret: APP_SECRET })).toBe(true)
  })

  it('rejects a signature made with a different app secret', () => {
    const header = sign(body, 'someone-elses-secret')
    expect(isValidSignature({ rawBody: body, header, appSecret: APP_SECRET })).toBe(false)
  })

  it('rejects a body altered after signing', () => {
    const header = sign(body)
    const tampered = Buffer.from(JSON.stringify({ object: 'tampered' }))
    expect(isValidSignature({ rawBody: tampered, header, appSecret: APP_SECRET })).toBe(false)
  })

  /**
   * The trap from TECH-STACK.md section 5: a parse-and-re-serialise round trip
   * changes the bytes, so the HMAC no longer matches even though the JSON is
   * semantically identical. This test exists to make that failure obvious.
   */
  it('rejects a body that was re-serialised after parsing', () => {
    const original = Buffer.from('{"object":"whatsapp_business_account",  "entry":[]}')
    const header = sign(original)
    const reserialised = Buffer.from(JSON.stringify(JSON.parse(original.toString('utf8'))))
    expect(isValidSignature({ rawBody: reserialised, header, appSecret: APP_SECRET })).toBe(false)
  })

  it('rejects a missing header', () => {
    expect(isValidSignature({ rawBody: body, header: null, appSecret: APP_SECRET })).toBe(false)
  })

  it('rejects an unprefixed or malformed header without throwing', () => {
    for (const header of ['', 'sha1=abc', 'sha256=', 'sha256=nothex', 'sha256=aabb']) {
      expect(isValidSignature({ rawBody: body, header, appSecret: APP_SECRET })).toBe(false)
    }
  })

  it('accepts a body containing multi-byte characters', () => {
    const arabic = Buffer.from(JSON.stringify({ text: 'مرحبا، أريد استئجار سيارة' }))
    expect(isValidSignature({ rawBody: arabic, header: sign(arabic), appSecret: APP_SECRET })).toBe(
      true,
    )
  })
})

describe('isValidVerifyToken', () => {
  it('accepts an exact match', () => {
    expect(isValidVerifyToken('correct-token', 'correct-token')).toBe(true)
  })

  it('rejects a different token', () => {
    expect(isValidVerifyToken('wrong-token', 'correct-token')).toBe(false)
  })

  it('rejects tokens of differing length without throwing', () => {
    expect(isValidVerifyToken('short', 'a-considerably-longer-token')).toBe(false)
    expect(isValidVerifyToken('', 'correct-token')).toBe(false)
  })
})


import { describe, expect, it } from 'vitest'
import {
  complaintAboutImage, hostsOf, imageSizeFrom, MAX_IMAGE_BYTES,
} from '../src/sendable-image.ts'

const facts = (over: Partial<Parameters<typeof complaintAboutImage>[0]> = {}) => ({
  status: 200, contentType: 'image/jpeg', contentLength: '159614', contentRange: null, ...over,
})

describe('a link that is fine', () => {
  it('has no complaint', () => {
    expect(complaintAboutImage(facts())).toBeNull()
  })

  it('accepts png as well as jpeg', () => {
    expect(complaintAboutImage(facts({ contentType: 'image/png' }))).toBeNull()
  })

  it('ignores the charset parameter', () => {
    expect(complaintAboutImage(facts({ contentType: 'image/jpeg; charset=binary' }))).toBeNull()
  })

  it('does not mind the case a server chooses', () => {
    expect(complaintAboutImage(facts({ contentType: 'IMAGE/JPEG' }))).toBeNull()
  })

  /**
   * The ranged fallback answering correctly. Treating 206 as a failure would
   * reject every host that refuses HEAD, which is a great many of them.
   */
  it('accepts a partial response from the ranged fallback', () => {
    expect(complaintAboutImage(facts({
      status: 206, contentLength: '1', contentRange: 'bytes 0-0/159614',
    }))).toBeNull()
  })

  /**
   * Some hosts omit the type on a HEAD and serve it correctly on the real GET.
   * Refusing a photograph that works is worse than allowing one that might not.
   */
  it('lets a missing content type through', () => {
    expect(complaintAboutImage(facts({ contentType: null }))).toBeNull()
  })
})

describe('a link that will send nothing', () => {
  /** The hotlink-protection case, and the moved-photograph case. */
  it('reports the status the customer will not see', () => {
    expect(complaintAboutImage(facts({ status: 403 }))).toContain('answered 403')
    expect(complaintAboutImage(facts({ status: 404 }))).toContain('send no picture')
  })

  it('names the format WhatsApp will not send', () => {
    const complaint = complaintAboutImage(facts({ contentType: 'image/webp' }))
    expect(complaint).toContain('webp')
    expect(complaint).toContain('jpeg and png only')
  })

  it('catches a link that is a web page rather than a picture', () => {
    expect(complaintAboutImage(facts({ contentType: 'text/html' })))
      .toContain('is not a picture')
  })

  it('refuses a photograph over five megabytes', () => {
    const complaint = complaintAboutImage(facts({ contentLength: String(MAX_IMAGE_BYTES + 1) }))
    expect(complaint).toContain('5MB')
  })

  it('reports the size in a unit a person reads', () => {
    expect(complaintAboutImage(facts({ contentLength: String(9 * 1024 * 1024) })))
      .toContain('9.0MB')
  })

  /**
   * The bug this function would otherwise have had. A one-byte ranged request
   * reports `content-length: 1`, so a 40MB photograph passes a naive size
   * check — the truth is after the slash in `content-range`.
   */
  it('sees the real size behind a one-byte range', () => {
    expect(complaintAboutImage({
      status: 206, contentType: 'image/jpeg',
      contentLength: '1', contentRange: `bytes 0-0/${40 * 1024 * 1024}`,
    })).toContain('40.0MB')
  })

  it('accepts a file exactly at the limit', () => {
    expect(complaintAboutImage(facts({ contentLength: String(MAX_IMAGE_BYTES) }))).toBeNull()
  })
})

describe('reading the size', () => {
  it('prefers the range over the length', () => {
    expect(imageSizeFrom({
      status: 206, contentType: null, contentLength: '1', contentRange: 'bytes 0-0/2048',
    })).toBe(2048)
  })

  it('falls back to the length when the range has no total', () => {
    expect(imageSizeFrom({
      status: 206, contentType: null, contentLength: '900', contentRange: 'bytes 0-0/*',
    })).toBe(900)
  })

  it('says nothing rather than guessing when no size was given', () => {
    expect(imageSizeFrom(facts({ contentLength: null }))).toBeNull()
    expect(imageSizeFrom(facts({ contentLength: '' }))).toBeNull()
    expect(imageSizeFrom(facts({ contentLength: 'unknown' }))).toBeNull()
  })

  /** A size that cannot be read must never become a complaint about size. */
  it('does not complain when the size is unreadable', () => {
    expect(complaintAboutImage(facts({ contentLength: 'unknown' }))).toBeNull()
  })
})

describe('where the photographs are served from', () => {
  /** The pilot's actual state: four pictures on a competitor's CDN. */
  it('names the host', () => {
    expect(hostsOf([
      'https://cdn.mkrentacar.com/wp-content/uploads/2025/04/lamborghini-06.jpg',
      'https://cdn.mkrentacar.com/wp-content/uploads/2025/04/lamborghini-03.jpg',
    ])).toEqual(['cdn.mkrentacar.com'])
  })

  it('lists each host once, in the order first seen', () => {
    expect(hostsOf([
      'https://a.example/1.jpg', 'https://b.example/2.jpg', 'https://a.example/3.jpg',
    ])).toEqual(['a.example', 'b.example'])
  })

  it('skips a link that will not parse rather than throwing', () => {
    expect(hostsOf(['not a url', 'https://a.example/1.jpg'])).toEqual(['a.example'])
  })

  it('has nothing to say about a car with no photographs', () => {
    expect(hostsOf([])).toEqual([])
  })
})

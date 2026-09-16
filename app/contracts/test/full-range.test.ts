import { describe, expect, it } from 'vitest'
import { offersTheFullRange, usableWebsite } from '../src/full-range.ts'

describe('offersTheFullRange', () => {
  it.each([
    'You can see our full range here.',
    'Here is the whole fleet.',
    'All of our cars are on the website.',
    'Have a look at our site for every one of them.',
    'Happy to send our complete line-up.',
  ])('reads %j as pointing them at everything', (reply) => {
    expect(offersTheFullRange(reply)).toBe(true)
  })

  /**
   * An ordinary reply must not attach a link. A link is an exit, and one
   * offered to somebody who did not ask costs the conversation they were
   * already having.
   */
  it.each([
    'The Huracán is AED 5,500 per day.',
    'We have about 120 cars — what sort of thing are you after?',
    'Which one would you like to see?',
    'I can show you the Cullinan next.',
  ])('leaves %j without one', (reply) => {
    expect(offersTheFullRange(reply)).toBe(false)
  })

  it('finds nothing in an empty reply', () => {
    expect(offersTheFullRange(null)).toBe(false)
  })
})

describe('usableWebsite', () => {
  it('accepts an https address', () => {
    expect(usableWebsite('https://example.com/fleet')).toBe('https://example.com/fleet')
  })

  it('trims what somebody pasted', () => {
    expect(usableWebsite('  https://example.com  ')).toBe('https://example.com/')
  })

  /** A customer sent somewhere the operator did not mean is the cost here. */
  it.each([
    'http://example.com',
    'javascript:alert(1)',
    'example.com',
    'not a url at all',
    '',
    '   ',
    null,
    undefined,
  ])('refuses %j', (url) => {
    expect(usableWebsite(url)).toBeNull()
  })
})

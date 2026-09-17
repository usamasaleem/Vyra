import { describe, expect, it } from 'vitest'
import { usableName } from '../src/customer-name.ts'

/**
 * A WhatsApp profile name is whatever somebody typed, and the pilot's own
 * contact row has the phone number in it. "Hello +971 50 123 4567" is worse
 * than no greeting.
 */
describe('a name you could call someone', () => {
  it.each(['Ahmed', 'Layla Haddad', 'Jean-Pierre', 'محمد', 'Анна', 'O’Brien'])(
    'keeps %j', (name) => { expect(usableName(name)).toBe(name) },
  )

  it('tidies the spacing rather than rejecting it', () => {
    expect(usableName('  Layla   Haddad ')).toBe('Layla Haddad')
  })

  it('keeps a name wearing decoration', () => {
    expect(usableName('🌹Rosa🌹')).toBe('🌹Rosa🌹')
  })
})

describe('things that are not a name', () => {
  /** The most common case by far: no profile name set. */
  it.each(['+971501234567', '971 50 123 4567', '+971 (50) 123-4567', '0501234567'])(
    'refuses the phone number %j', (name) => { expect(usableName(name)).toBeNull() },
  )

  it.each(['🌹🌹🌹', '✨', '...', '---', '😎'])(
    'refuses decoration with no name in it: %j', (name) => {
      expect(usableName(name)).toBeNull()
    },
  )

  /** A company is not a person, however friendly. */
  it.each([
    'MK Rent A Car LLC',
    'Dubai Luxury Motors',
    'Falcon Tourism',
    'Prestige Cars',
  ])('refuses the business name %j', (name) => { expect(usableName(name)).toBeNull() })

  it('refuses a tagline', () => {
    expect(usableName('Luxury car rental Dubai | best prices | call now')).toBeNull()
  })

  it.each([null, undefined, '', '   '])('refuses %j', (name) => {
    expect(usableName(name)).toBeNull()
  })

  /** One letter is an initial, not something to greet somebody by. */
  it('refuses a single letter', () => {
    expect(usableName('A')).toBeNull()
  })
})

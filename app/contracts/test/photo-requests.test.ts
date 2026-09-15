import { describe, expect, it } from 'vitest'
import { asksToSeePhotos } from '../src/photo-requests.ts'

describe('asksToSeePhotos', () => {
  /** Both taken from a live conversation where both got prose. */
  it.each([
    'Can you send me more images related to this car',
    'show me side profile',
    'can i see it?',
    'send photos please',
    'what does it look like',
    'any other angles?',
    'show me the interior',
    'can we see more pics',
  ])('reads %j as asking to see the car', (text) => {
    expect(asksToSeePhotos(text)).toBe(true)
  })

  /**
   * An ordinary question about the car is not a request for pictures. Sending
   * them anyway would put the once-only rule back where it started.
   */
  it.each([
    'how much is it per day?',
    'is it available this weekend?',
    'what engine does it have?',
    'tell me about the green lambo',
    'i want to rent it',
  ])('reads %j as an ordinary question', (text) => {
    expect(asksToSeePhotos(text)).toBe(false)
  })

  it('finds nothing in an empty message', () => {
    expect(asksToSeePhotos(null)).toBe(false)
    expect(asksToSeePhotos('  ')).toBe(false)
  })
})

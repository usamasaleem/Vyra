import { describe, expect, it } from 'vitest'
import { systemPromptFor } from '../src/turn/prompt.ts'

/**
 * What the model is handed about its own past messages.
 *
 * Read out of a real transcript: "I sent you 7 photos of the Lamborghini
 * Huracán on the 15th", three times in six minutes, once with the count
 * changed to 9. The model was not inventing — it was repeating the fact it had
 * been given, which read "7 of the Lamborghini Huracán on 15 September".
 *
 * A model repeats the precision it is handed. So the test is on the fact.
 */
const now = new Date('2026-09-16T10:00:00Z')

const prompt = (photosShown: Parameters<typeof systemPromptFor>[0]['photosShown']) =>
  systemPromptFor({ now, timezone: 'Asia/Dubai', enquiryId: 'e1', photosShown })

describe('what it is told about photographs it has sent', () => {
  const huracan = {
    make: 'Lamborghini', model: 'Huracán', sent: 7,
    lastSentAt: new Date('2026-09-16T04:00:00Z'),
  }

  it('says when, the way a person says it', () => {
    expect(prompt([huracan])).toContain('the Lamborghini Huracán earlier today')
  })

  /**
   * Asserted on the sentence we inject rather than on the whole prompt, which
   * legitimately contains a September in a date-confirmation example. Testing
   * the whole thing caught that — and also caught the instruction itself
   * quoting "7 photos on 16 September" as what not to say, which is a negative
   * example priming exactly the words it forbids.
   */
  const fact = (shown: Parameters<typeof prompt>[0]) => {
    const text = prompt(shown)
    const from = text.indexOf('already sent this customer')
    return from === -1 ? '' : text.slice(from, from + 240)
  }

  /** Nobody counts their own photographs out loud. */
  it('never hands over a count', () => {
    expect(fact([huracan])).not.toMatch(/\d/)
  })

  it('never hands over a date', () => {
    expect(fact([{ ...huracan, lastSentAt: new Date('2026-09-13T04:00:00Z') }]))
      .toContain('on Sunday')
    expect(fact([huracan])).not.toContain('September')
  })

  it('names both cars when both have been shown', () => {
    const text = prompt([
      huracan,
      { make: 'Ferrari', model: '488', sent: 3, lastSentAt: new Date('2026-09-15T04:00:00Z') },
    ])
    expect(text).toContain('the Lamborghini Huracán earlier today, and the Ferrari 488 yesterday')
  })

  it('says nothing at all when nothing has been sent', () => {
    expect(prompt([])).not.toContain('already sent this customer')
  })
})

/**
 * Every reply in the transcript opened with an acknowledgement — five
 * different words doing one identical move, without exception.
 */
describe('the instruction about opening a message', () => {
  it('tells it not to open every message the same way', () => {
    const text = prompt([])
    expect(text).toContain('Do not open every message the same way')
    expect(text).toContain('Of course')
  })
})

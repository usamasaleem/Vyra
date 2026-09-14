import { describe, expect, it } from 'vitest'
import { detectOptOut } from '../src/opt-out.ts'

describe('messages that are an opt-out', () => {
  it.each([
    'stop',
    'STOP',
    'Stop.',
    'unsubscribe',
    'please stop messaging me',
    'stop texting me',
    'do not contact me again',
    "don't message me anymore",
    "don't contact me",
    'remove me from your list',
    'take me off this list',
    'delete my number',
    'leave me alone',
    'I no longer wish to be contacted',
    'opt out',
    'stop these messages',
  ])('%s', (message) => {
    expect(detectOptOut(message)).not.toBeNull()
  })

  it('reports what matched, so the decision can be explained and reversed', () => {
    expect(detectOptOut('please stop messaging me')).toMatchObject({ matched: 'stop messaging' })
  })
})

describe('messages that are not', () => {
  /**
   * Every one of these is a live customer. A false opt-out ends the
   * conversation silently — the dispatcher then refuses every send to them,
   * staff included — so these matter more than the positives.
   */
  it.each([
    'can I stop by the showroom?',
    'stop by tomorrow to pick it up?',
    'can you stop the charge on my card',
    'non-stop from Friday to Sunday',
    // A lost lead, not an opt-out. Completely different consequence.
    'not interested',
    'not interested in the Ferrari, what else do you have?',
    'I want to cancel my booking',
    'cancel the Lamborghini please',
    'do not deliver before 9am',
    // Channel preferences, not opt-outs. The first of these fired before the
    // pattern required a word of finality or the end of the message.
    "don't call me before noon, message is fine",
    "don't message me before 9am please",
    'do not contact me on this number after 10pm',
    'how do I remove the child seat',
  ])('%s', (message) => {
    expect(detectOptOut(message)).toBeNull()
  })
})

describe('Arabic', () => {
  // Model-written patterns. A native speaker must review these before they
  // silence anyone — see the warning in the source.
  it.each(['توقف', 'لا تراسلني', 'احذف رقمي', 'إلغاء الاشتراك'])('%s', (message) => {
    expect(detectOptOut(message)).not.toBeNull()
  })

  it('does not fire on an ordinary Arabic enquiry', () => {
    expect(detectOptOut('أبغى أستأجر لامبورغيني بكرة')).toBeNull()
  })
})

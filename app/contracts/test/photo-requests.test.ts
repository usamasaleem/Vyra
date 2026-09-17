import { describe, expect, it } from 'vitest'
import { asksToSeePhotos, photosPromisedIn } from '../src/photo-requests.ts'

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
    // The one that reached a customer: it names the car, not the pictures.
    'can you show me the lambo?',
    'show me the huracan',
    'can I see the Ferrari',
    "let's see it",
    'show me',
    'how does it look',
    "i'd like to see the car",
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
    // "show me the X" where X is not something you can photograph. Without
    // this the broader patterns answer a pricing question with pictures.
    'show me the price',
    'can i see the rates for next week',
    'show me the available dates',
    'show me your terms and conditions',
    'can we see the discount options',
  ])('reads %j as an ordinary question', (text) => {
    expect(asksToSeePhotos(text)).toBe(false)
  })

  /** The picture noun settles it, whatever else the sentence asks for. */
  it('still sends pictures when they are asked for alongside a price', () => {
    expect(asksToSeePhotos('show me the photos and the price')).toBe(true)
  })

  it('finds nothing in an empty message', () => {
    expect(asksToSeePhotos(null)).toBe(false)
    expect(asksToSeePhotos('  ')).toBe(false)
  })
})

describe('photosPromisedIn', () => {
  /**
   * The future tense is the same debt. Live: "Sure — I'll get the green
   * Huracán Tecnica photos resent, with a few different angles", to somebody
   * who had just typed "can you send again". Nothing followed it.
   */
  it.each([
    "Sure — I'll get the green Hurac\u00e1n Tecnica photos resent, with a few different angles.",
    "I'll send you a few more pictures now.",
    'Let me get some different angles over to you.',
    'I will share some photos of it.',
    'Happy to send those again.',
    /**
     * The phrasing the instructions ask for when a car has no photographs on
     * file, and it belongs here rather than in the list below. If the car has
     * some, this sends them; if it has none there is nothing to send and the
     * sentence is a genuine promise for a person to keep. Reading it as a
     * promise is right in both cases.
     */
    'I will get some photos of that one for you.',
  ])('reads %j as owing photographs', (reply) => {
    expect(photosPromisedIn(reply)).toBe(true)
  })

  /** Offering is not promising, and must not send anything on its own. */
  it.each([
    'Would you like to see some pictures?',
    'I can send you photos if you like.',
  ])('reads %j as an offer rather than a promise', (reply) => {
    expect(photosPromisedIn(reply)).toBe(false)
  })

  /** The first is verbatim from the reply that attached nothing. */
  it.each([
    "Of course \u2014 the Lamborghini Hurac\u00e1n Tecnica in Verde green. I\u2019ve attached the photos here.",
    'Here are some pictures of the car.',
    'Sending the photos now.',
    'Photos below.',
    'Have a look at these pictures.',
    "Here's a few images for you.",
  ])('reads %j as claiming an attachment', (reply) => {
    expect(photosPromisedIn(reply)).toBe(true)
  })

  /**
   * Talking about photographs is not claiming to have sent any. An offer must
   * not trigger a send the model did not make.
   */
  it.each([
    'I can send you photos if you like.',
    'Would you like to see some pictures?',
    'The Hurac\u00e1n is AED 5,500 per day.',
  ])('reads %j as not claiming one', (reply) => {
    expect(photosPromisedIn(reply)).toBe(false)
  })

  it('reads a typographic apostrophe the same as a plain one', () => {
    expect(photosPromisedIn('I\u2019ve attached the photos here.')).toBe(true)
    expect(photosPromisedIn("I've attached the photos here.")).toBe(true)
  })

  it('finds nothing in an empty reply', () => {
    expect(photosPromisedIn(null)).toBe(false)
  })
})

/**
 * One conversation, three asks, two ignored.
 *
 * "can you send again" got prose. "are you sending the images again or not?"
 * got prose. The photographs arrived on the third attempt, and only because
 * the reply happened to claim they were being resent — the claimed-attachment
 * path, not this one.
 *
 * The cause was `\bsend\b`: a word boundary does not exist inside "resend",
 * or before the g in "sending".
 */
describe('asking for them again', () => {
  it.each([
    'can you send again',
    'are you sending the images again or not?',
    'can you resend the photos',
    'resend',
    'send them again',
    'could you re-send those',
    'show me again',
  ])('hears %j', (message) => {
    expect(asksToSeePhotos(message)).toBe(true)
  })

  /**
   * "Again" on its own is not about pictures. The repeat patterns are implicit
   * rather than explicit precisely so this guard still applies to them.
   */
  it.each([
    'can you send the quote again',
    'send me the rates again',
    'can you check availability again',
    'show me the price again',
  ])('does not hear %j', (message) => {
    expect(asksToSeePhotos(message)).toBe(false)
  })
})

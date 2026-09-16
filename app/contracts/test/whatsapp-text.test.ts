import { describe, expect, it } from 'vitest'
import { asWhatsAppText, formatDateForMessage } from '../src/whatsapp-text.ts'

describe('asWhatsAppText', () => {
  /** The v1 failure, verbatim: a customer saw the asterisks. */
  it('turns Markdown bold into the one asterisk WhatsApp draws', () => {
    expect(asWhatsAppText('Lamborghini from **Thursday, 17 September**'))
      .toBe('Lamborghini from *Thursday, 17 September*')
  })

  it('does the same for underscores', () => {
    expect(asWhatsAppText('__Verde green__')).toBe('_Verde green_')
  })

  it('makes a heading bold rather than showing a hash', () => {
    expect(asWhatsAppText('## Our range\nCullinan')).toBe('*Our range*\nCullinan')
  })

  /** A raw URL in a sales message is noise; the words are what was meant. */
  it('keeps the words of a link and drops the address', () => {
    expect(asWhatsAppText('See [our fleet](https://example.com/fleet) here'))
      .toBe('See our fleet here')
  })

  /**
   * Conservative on purpose. A reply is a person's words and rewriting them is
   * not something this system does.
   */
  it.each([
    'It is AED 5,500 per day.',
    'The 488 * 2 days is not arithmetic I do.',
    'Model_S is the name, not italics.',
    '*Already correct* for WhatsApp.',
    'A hash # mid-sentence stays.',
    'Ratio 3**2 is not bold.',
  ])('leaves %j alone', (text) => {
    expect(asWhatsAppText(text)).toBe(text)
  })

  it('handles an empty reply', () => {
    expect(asWhatsAppText('')).toBe('')
  })
})

describe('formatDateForMessage', () => {
  /**
   * "Valid until 2026-09-17" went out on a real quote. The instructions forbid
   * the model from writing a year; the code was doing it anyway.
   */
  it('writes the date the way a person does, with no year', () => {
    const formatted = formatDateForMessage(new Date('2026-09-17T08:00:00Z'), 'Asia/Dubai')
    expect(formatted).toBe('Thursday 17 September')
    expect(formatted).not.toContain('2026')
  })

  it('reads the date in the operator timezone, not the server one', () => {
    // Late on the 17th in London is already the 18th in Dubai.
    const at = new Date('2026-09-17T21:30:00Z')
    expect(formatDateForMessage(at, 'Asia/Dubai')).toBe('Friday 18 September')
    expect(formatDateForMessage(at, 'Europe/London')).toBe('Thursday 17 September')
  })
})

import { describe, expect, it } from 'vitest'
import { renderExamples, VOICE_EXAMPLES } from '../src/turn/examples.ts'
import { SYSTEM_PROMPT } from '../src/turn/prompt.ts'

describe('the voice examples', () => {
  /**
   * An example that fabricates is an example teaching the model to fabricate.
   * Every figure here must be one a tool actually returns, and the two that
   * appear are the confirmed Cullinan rate and a number the customer offered.
   */
  const ALLOWED_FIGURES = new Set(['8000', '3000', '488', '5.2', '20', '23'])

  it.each(VOICE_EXAMPLES)('states no invented figure: $customer', (example) => {
    // An engine designation is a name, not a figure: "V10" and "5.2 V10" say
    // what the car is, the way "488" does.
    const withoutEngines = example.agent.replace(/\bV\d{1,2}\b/g, '')
    const figures = (withoutEngines.match(/\d[\d,.]*/g) ?? [])
      .map((f) => f.replace(/[,.]$/, '').replace(/,/g, ''))
    for (const figure of figures) {
      expect(ALLOWED_FIGURES.has(figure), `unexpected figure "${figure}"`).toBe(true)
    }
  })

  /** WhatsApp does not render Markdown; an example with asterisks teaches them. */
  it.each(VOICE_EXAMPLES)('uses no Markdown: $customer', (example) => {
    expect(example.agent).not.toMatch(/\*\*|__|^[-*] /m)
  })

  /**
   * They demonstrate brevity, so they have to be brief. An example longer than
   * the replies it is meant to shape teaches the opposite of its point.
   */
  it.each(VOICE_EXAMPLES)('stays short: $customer', (example) => {
    expect(example.agent.split(/\s+/).length).toBeLessThanOrEqual(35)
  })

  it('reaches the model', () => {
    expect(SYSTEM_PROMPT).toContain(VOICE_EXAMPLES[0]!.agent)
    expect(renderExamples()).toContain('Customer:')
    expect(renderExamples()).toContain('You:')
  })

  /**
   * Cheap because it is cached, but only while it stays small. A set that grows
   * to fifty examples is a bill on every conversation.
   */
  it('stays small enough to sit in a cached prefix', () => {
    expect(renderExamples().length).toBeLessThan(2000)
  })
})

import { describe, expect, it } from 'vitest'
import { placeholderPolicy } from '../src/fixtures/placeholder-policy.ts'
import { assertPublishable, openQuestions, PlaceholderKnowledgeError, type KnowledgeEntry } from '../src/knowledge.ts'
import { qualification } from '../src/qualification.ts'

const confirmed = (over: Partial<KnowledgeEntry> = {}): KnowledgeEntry => ({
  topic: 'deposit',
  covers: 'what deposit is required',
  answer: 'AED 5,000, released within 14 days.',
  provenance: 'operator-confirmed',
  confirmedBy: 'Ahmed, operations manager',
  confirmedAt: '2026-09-20',
  ...over,
})

describe('placeholder knowledge cannot be published', () => {
  /** The property this whole file exists for. */
  it('refuses the entire placeholder set', () => {
    expect(() => assertPublishable(placeholderPolicy)).toThrow(PlaceholderKnowledgeError)
  })

  it('names every topic it refused, so the list is actionable', () => {
    try {
      assertPublishable(placeholderPolicy)
      throw new Error('should have refused')
    } catch (error) {
      expect(error).toBeInstanceOf(PlaceholderKnowledgeError)
      expect((error as PlaceholderKnowledgeError).topics).toEqual(
        placeholderPolicy.map((e) => e.topic),
      )
    }
  })

  it('refuses a set where even one entry is still placeholder', () => {
    expect(() =>
      assertPublishable([confirmed(), confirmed({ topic: 'delivery', provenance: 'placeholder' })]),
    ).toThrow(/delivery/)
  })

  /** No flag, no environment override, no "just this once". */
  it('has no way to force publication', () => {
    expect(assertPublishable.length).toBe(1)
    const source = assertPublishable.toString()
    expect(source).not.toMatch(/process\.env|force|override|skip/i)
  })
})

describe('confirmed knowledge needs attribution', () => {
  it('accepts an entry confirmed by a named person on a date', () => {
    expect(() => assertPublishable([confirmed()])).not.toThrow()
  })

  it('refuses knowledge confirmed by nobody', () => {
    expect(() => assertPublishable([confirmed({ confirmedBy: undefined })])).toThrow(/confirmed by whom/)
  })

  it('refuses knowledge confirmed at no particular time', () => {
    expect(() => assertPublishable([confirmed({ confirmedAt: undefined })])).toThrow(/when/)
  })
})

describe('the placeholder set is honest about itself', () => {
  it('marks every entry as placeholder', () => {
    for (const entry of placeholderPolicy) {
      expect(entry.provenance, entry.topic).toBe('placeholder')
    }
  })

  it('claims no attribution it does not have', () => {
    for (const entry of placeholderPolicy) {
      expect(entry.confirmedBy, entry.topic).toBeUndefined()
      expect(entry.confirmedAt, entry.topic).toBeUndefined()
    }
  })

  it('covers every eval case that was blocked on operator policy', () => {
    const blocked = qualification.cases.filter((c) => c.needsOperatorAnswer).map((c) => c.id)
    const covered = new Set(placeholderPolicy.map((e) => e.unblocksEvalCase))
    for (const id of blocked) {
      expect(covered.has(id), `no placeholder answer for eval case "${id}"`).toBe(true)
    }
  })

  it('reports what is still outstanding', () => {
    const open = openQuestions(placeholderPolicy)
    console.log(`\n  ${open.length} answers still invented and awaiting the operator:`)
    for (const e of open) console.log(`    · ${e.topic} — ${e.covers}`)
    expect(open).toHaveLength(placeholderPolicy.length)
  })
})

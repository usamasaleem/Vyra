import { describe, expect, it } from 'vitest'
import { qualification } from '../src/qualification.ts'

/**
 * The eval set has no model to run against yet, so these check the set itself:
 * that it is well formed, traceable, and actually covers the safety rules it
 * claims to. A blank eval set that passes is worse than none.
 */
describe('the eval set is well formed', () => {
  it('every case cites where it comes from', () => {
    for (const c of qualification.cases) {
      expect(c.source, c.id).toMatch(/§|MVP/)
    }
  })

  it('every case states something it must not do', () => {
    for (const c of qualification.cases) {
      expect(c.mustNotDo.length, c.id).toBeGreaterThan(0)
    }
  })

  it('every case needing operator knowledge says what to ask', () => {
    for (const c of qualification.cases.filter((c) => c.needsOperatorAnswer)) {
      expect(c.operatorQuestion, c.id).toBeTruthy()
    }
  })

  it('has unique ids', () => {
    const ids = qualification.cases.map((c) => c.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('it covers the safety rules', () => {
  const joined = qualification.cases.map((c) => c.mustNotDo.join(' ').toLowerCase()).join(' | ')

  it.each([
    ['unverified availability', /state availability/],
    ['confirming a booking', /confirm a booking/],
    ['approving a discount', /promise the discount|approve an exception/],
    ['verifying payment', /payment as received|deposit is settled/],
    ['answering with no source', /invent a figure|guess/],
  ])('forbids %s somewhere in the set', (_label, pattern) => {
    expect(joined).toMatch(pattern)
  })
})

describe('what still needs the operator', () => {
  it('reports the open questions rather than hiding them', () => {
    const open = qualification.cases.filter((c) => c.needsOperatorAnswer)
    console.log(`\n  ${open.length} of ${qualification.cases.length} cases need the operator's own policy:`)
    for (const c of open) console.log(`    · ${c.id}`)
    expect(open.length).toBeGreaterThan(0)
  })
})

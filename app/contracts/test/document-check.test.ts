import { describe, expect, it } from 'vitest'
import { ageOn, evaluateDocuments, licenceAcceptedAlone, sameName, type ReadDocument } from '../src/document-check.ts'

const VISITOR_RULES = 'Licences from the GCC, UK, EU, US, Canada, Australia, New Zealand, Japan and South Korea are accepted on their own'

const licence = (over: Partial<ReadDocument> = {}): ReadDocument => ({
  kind: 'driving_licence', legible: true, country: 'United Kingdom', fullName: 'John Alan Smith',
  dateOfBirth: '1990-03-14', expiryDate: '2031-02-11', issueDate: '2010-05-01', ...over,
})
const passport = (over: Partial<ReadDocument> = {}): ReadDocument => ({
  kind: 'passport', legible: true, country: 'United Kingdom', fullName: 'SMITH JOHN ALAN',
  dateOfBirth: '1990-03-14', expiryDate: '2030-01-01', issueDate: null, ...over,
})
const check = (documents: ReadDocument[], over: Partial<Parameters<typeof evaluateDocuments>[0]> = {}) =>
  evaluateDocuments({
    documents, rentalStart: '2026-09-26', rentalEnd: '2026-09-28', minimumAge: 25,
    minimumLicenceYears: 1, visitor: true, visitorRules: VISITOR_RULES, ...over,
  })

describe('checking a licence and an ID', () => {
  it('approves a clear, valid pair and says why', () => {
    const result = check([licence(), passport()])
    expect(result.verdict).toBe('approved')
    expect(result.reasons).toContain('Driver is 36 on the first day.')
    expect(result.reasons).toContain('Same name on both.')
  })

  it('asks for a clearer photo rather than guessing', () => {
    const result = check([licence({ legible: false }), passport()])
    expect(result).toMatchObject({ verdict: 'unreadable' })
    expect((result as { ask: string }).ask).toMatch(/driving licence/)
  })

  it('asks for the ID the customer can actually have', () => {
    expect(check([licence()])).toMatchObject({ verdict: 'unreadable', ask: expect.stringMatching(/passport/) })
    expect(check([licence()], { visitor: false })).toMatchObject({ ask: expect.stringMatching(/Emirates ID/) })
  })

  it.each([
    ['a licence that runs out during the rental', [licence({ expiryDate: '2026-09-27' }), passport()], /licence expires/],
    ['a driver under the minimum age', [licence({ dateOfBirth: '2003-01-01' }), passport({ dateOfBirth: '2003-01-01' })], /driver is 23/i],
    ['a licence held under a year', [licence({ issueDate: '2026-03-01' }), passport()], /less than 1 year/],
    ['two different people', [licence({ fullName: 'Jane Doe' }), passport()], /names differ/],
    ['an expiry nobody could read', [licence({ expiryDate: null }), passport()], /Could not read when the licence expires/],
    ['a visitor licence the operator does not accept alone', [licence({ country: 'India' }), passport()], /International Driving Permit/],
  ])('hands %s to a person, with the reason', (_, documents, reason) => {
    const result = check(documents)
    expect(result.verdict).toBe('problem')
    expect(result.reasons.join(' ')).toMatch(reason)
  })

  it('does not ask a resident for an international permit', () => {
    expect(check([licence({ country: 'India' }), passport()], { visitor: false }).verdict).toBe('approved')
  })
})

describe('the pieces', () => {
  it('counts birthdays properly', () => {
    expect(ageOn(new Date('2001-09-27'), new Date('2026-09-26'))).toBe(24)
    expect(ageOn(new Date('2001-09-26'), new Date('2026-09-26'))).toBe(25)
  })

  it.each([
    ['John Alan Smith', 'SMITH JOHN ALAN', true],
    ['John Smith', 'SMITH JOHN ALAN', true],
    ['José García', 'JOSE GARCIA LOPEZ', true],
    ['John Smith', 'Jane Smith', false],
  ])('%s and %s are the same person: %s', (a, b, expected) => {
    expect(sameName(a, b)).toBe(expected)
  })

  it('reads the accepted countries from the operator’s own words', () => {
    expect(licenceAcceptedAlone('Germany', VISITOR_RULES)).toBe(true)
    expect(licenceAcceptedAlone('Saudi Arabia', VISITOR_RULES)).toBe(true)
    expect(licenceAcceptedAlone('United Arab Emirates', VISITOR_RULES)).toBe(true)
    expect(licenceAcceptedAlone('India', VISITOR_RULES)).toBe(false)
    expect(licenceAcceptedAlone('Switzerland', VISITOR_RULES)).toBe(false)
  })
})

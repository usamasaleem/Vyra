import { describe, expect, it } from 'vitest'
import { promiseMadeIn } from '../src/promises.ts'

/**
 * The sentence that started this is the first case. It was sent to a real
 * customer, and nothing in the system knew it had been.
 */
describe('promiseMadeIn', () => {
  it('catches the reply that was actually sent', () => {
    expect(promiseMadeIn(
      'I’ll get a salesperson to confirm the highest-priced car and its exact rate for you. They’ll take it from here.',
    )).toBe('person')
  })

  it.each([
    'I’ll have a salesperson confirm which car has the highest rate, then message you back.',
    'I’ll check with the sales team which car currently has the highest daily rate.',
    'A salesperson will get back to you shortly.',
    'The team will message you with the exact figure.',
    'Passing this to the sales team now.',
    'I’m connecting you with a colleague who can help.',
    'Let me ask someone on the team and come back to you.',
  ])('reads %j as promising a person', (reply) => {
    expect(promiseMadeIn(reply)).toBe('person')
  })

  it.each([
    'I’ll check the deposit and come straight back.',
    'Let me confirm whether it is free on those dates.',
    'I’ll find out and let you know.',
    'I will get back to you on that.',
  ])('reads %j as promising to check', (reply) => {
    expect(promiseMadeIn(reply)).toBe('check')
  })

  /**
   * A promise of a person outranks a promise to check. Both in one sentence is
   * one commitment, and raising two tasks for it is how a queue becomes noise.
   */
  it('prefers the person when a reply promises both', () => {
    expect(promiseMadeIn(
      'I’ll check with the sales team and come back to you with the exact price.',
    )).toBe('person')
  })

  it.each([
    'The Rolls-Royce Cullinan is AED 8,000 per day.',
    'Nice choice — the yellow one is the 488 Spider.',
    '15th to 18th September, Tuesday to Friday — that right?',
    'We have the Huracán EVO Spyder in Arancio Borealis.',
    'Our most expensive car is the 2024 Rolls-Royce Cullinan at AED 8,000 per day.',
  ])('does not see a promise in %j', (reply) => {
    expect(promiseMadeIn(reply)).toBeNull()
  })

  it('finds nothing in an empty or missing reply', () => {
    expect(promiseMadeIn(null)).toBeNull()
    expect(promiseMadeIn('   ')).toBeNull()
  })
})

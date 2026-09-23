import { describe, expect, it } from 'vitest'
import { isOnlyAGreeting } from '../src/automated-messages.ts'

/**
 * Live: "Hi, do you have a Ferrari" got a welcome asking them to say what
 * they were looking for, ten seconds before the answer. The greeting is for
 * somebody who has only said hello.
 */
describe('a first message that is only a hello', () => {
  it.each([
    'hi', 'Hello!', 'hey there', 'Hi 👋', 'Good morning', 'Assalamu alaikum', 'As-salamu alaykum',
    'salam', 'مرحبا', 'السلام عليكم', 'hello?', 'Hi team',
  ])('is one: %s', (body) => {
    expect(isOnlyAGreeting(body)).toBe(true)
  })

  it.each([
    'Hi, do you have a Ferrari', 'hello, how much is the Lamborghini?', 'hi I need a car tomorrow',
    'مرحبا عندكم فيراري؟', '', '👋', null,
  ])('is not: %s', (body) => {
    expect(isOnlyAGreeting(body)).toBe(false)
  })
})

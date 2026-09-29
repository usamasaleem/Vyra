import { describe, expect, it } from 'vitest'
import {
  BUSY_INTERVAL_MS,
  BUSY_WINDOW_MS,
  IDLE_INTERVAL_MS,
  QUIET_INTERVAL_MS,
  QUIET_WINDOW_MS,
  relayDelayMs,
} from '../src/idle-delay.ts'

describe('how often the relay looks at the outbox', () => {
  it('keeps looking quickly while work is fresh, so a reply is sent as soon as it exists', () => {
    expect(relayDelayMs(0)).toBe(BUSY_INTERVAL_MS)
    expect(relayDelayMs(BUSY_WINDOW_MS - 1)).toBe(BUSY_INTERVAL_MS)
  })

  it('slows to once a second, then once every two seconds, as it stays quiet', () => {
    expect(relayDelayMs(BUSY_WINDOW_MS)).toBe(QUIET_INTERVAL_MS)
    expect(relayDelayMs(QUIET_WINDOW_MS - 1)).toBe(QUIET_INTERVAL_MS)
    expect(relayDelayMs(QUIET_WINDOW_MS)).toBe(IDLE_INTERVAL_MS)
    expect(relayDelayMs(24 * 60 * 60_000)).toBe(IDLE_INTERVAL_MS)
  })

  it('never waits longer than two seconds, which is all the first message after quiet pays', () => {
    expect(IDLE_INTERVAL_MS).toBeLessThanOrEqual(2_000)
  })

  it('sends about an eighth of the idle traffic it did at the old fixed 250 ms', () => {
    expect(IDLE_INTERVAL_MS / 250).toBe(8)
  })
})

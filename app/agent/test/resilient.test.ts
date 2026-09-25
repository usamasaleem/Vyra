import { describe, expect, it } from 'vitest'
import type { ModelAdapter, ModelResponse } from '../src/turn/model.ts'
import { isBrief, resilientModel, type ModelEvent } from '../src/turn/adapters/resilient.ts'

const REPLY: ModelResponse = { toolCalls: [], reply: 'Hello' }
const REQUEST = { system: 's', transcript: [], tools: [] }

/** A model that fails with each error in turn, then answers. */
function flaky(id: string, errors: string[]): ModelAdapter & { calls: number } {
  const adapter = {
    label: id, modelId: id, calls: 0,
    complete: async () => {
      const error = errors[adapter.calls++]
      if (error !== undefined) throw new Error(error)
      return REPLY
    },
  }
  return adapter
}

describe('a model having a bad minute', () => {
  it('tries a brief failure again on the same model', async () => {
    const primary = flaky('luna', ['openai 503: overloaded'])
    const fallback = flaky('backup', [])
    const events: ModelEvent[] = []
    const model = resilientModel({ primary, fallback, retryDelayMs: 0, onEvent: (e) => events.push(e) })
    expect(await model.complete(REQUEST)).toEqual(REPLY)
    expect([primary.calls, fallback.calls]).toEqual([2, 0])
    expect(events.map((e) => e.event)).toEqual(['model.retry'])
  })

  it('goes to the second model when the retry fails too', async () => {
    const primary = flaky('luna', ['openai 429: slow down', 'openai 429: slow down'])
    const fallback = flaky('backup', [])
    const events: ModelEvent[] = []
    const model = resilientModel({ primary, fallback, retryDelayMs: 0, onEvent: (e) => events.push(e) })
    expect(await model.complete(REQUEST)).toEqual(REPLY)
    expect(events.map((e) => e.event)).toEqual(['model.retry', 'model.fallback'])
  })

  /** A minute has already gone; a second minute on the same model is not a plan. */
  it('does not wait out a timeout twice', async () => {
    const primary = flaky('luna', ['openai timed out after 60s'])
    const fallback = flaky('backup', [])
    const model = resilientModel({ primary, fallback, retryDelayMs: 0 })
    expect(await model.complete(REQUEST)).toEqual(REPLY)
    expect([primary.calls, fallback.calls]).toEqual([1, 1])
  })

  it('fails the turn only when both have failed, saying both', async () => {
    const model = resilientModel({
      primary: flaky('luna', ['openai 400: bad request']),
      fallback: flaky('backup', ['openai 500: down']),
      retryDelayMs: 0,
    })
    await expect(model.complete(REQUEST)).rejects.toThrow(/openai 400: bad request — and the fallback backup failed too: openai 500/)
  })

  it('without a fallback, still retries once and then fails', async () => {
    const primary = flaky('luna', ['fetch failed', 'fetch failed'])
    const model = resilientModel({ primary, retryDelayMs: 0 })
    await expect(model.complete(REQUEST)).rejects.toThrow(/fetch failed/)
    expect(primary.calls).toBe(2)
  })

  it.each([
    ['openai 429: rate limit', true],
    ['openai 503: unavailable', true],
    ['fetch failed', true],
    ['openai timed out after 60s', false],
    ['openai 400: invalid schema', false],
    ['openai 401: bad key', false],
  ])('%s is brief: %s', (message, expected) => {
    expect(isBrief(new Error(message))).toBe(expected)
  })
})

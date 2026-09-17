import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { openaiModel } from '../src/turn/adapters/openai.ts'

/**
 * A request that is accepted and never answered.
 *
 * Not a refused connection, which fails immediately and was never the problem.
 * This is the live failure: the socket opens, the server takes the request, and
 * nothing comes back. Without a timeout the promise never settles, the task
 * function never returns, and the job stays locked — which cost one customer
 * ten and a half minutes while the worker itself stayed perfectly healthy.
 */
let server: Server | undefined

afterEach(() => {
  server?.close()
  server = undefined
})

const hangingModel = async (timeoutMs: number) => {
  server = createServer(() => {})
  const port = await new Promise<number>((resolve) => {
    server!.listen(0, () => resolve((server!.address() as { port: number }).port))
  })
  return openaiModel({
    apiKey: 'k', model: 'm', baseUrl: `http://127.0.0.1:${port}`, timeoutMs,
  })
}

const request = { system: 's', tools: [], transcript: [] }

describe('a model call that never comes back', () => {
  it('gives up rather than waiting forever', async () => {
    const model = await hangingModel(300)
    await expect(model.complete(request)).rejects.toThrow(/timed out/)
  })

  /** Named, so the agent_runs row says which failure this was. */
  it('says it was a timeout and how long it waited', async () => {
    const model = await hangingModel(300)
    await expect(model.complete(request)).rejects.toThrow('openai timed out after 0.3s')
  })

  it('gives up close to the limit rather than long after it', async () => {
    const model = await hangingModel(300)
    const began = Date.now()
    await expect(model.complete(request)).rejects.toThrow()
    expect(Date.now() - began).toBeLessThan(3000)
  })
})

/**
 * Fast mode is a queue, not a model. It must reach the wire as a service tier
 * and must not quietly become the default for anyone who did not ask for it.
 */
describe('the service tier', () => {
  const bodyOf = async (tier?: 'fast') => {
    let sent: Record<string, unknown> | undefined
    const original = globalThis.fetch
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body)) as Record<string, unknown>
      return new Response(JSON.stringify({ output: [], usage: {} }), {
        status: 200, headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch
    try {
      const model = openaiModel({
        apiKey: 'k', model: 'gpt-5.6-luna', effort: 'low',
        ...(tier === undefined ? {} : { serviceTier: tier }),
      })
      await model.complete({ system: 's', tools: [], transcript: [] })
      return { body: sent!, modelId: model.modelId }
    } finally {
      globalThis.fetch = original
    }
  }

  it('sends the tier when one is asked for', async () => {
    const { body } = await bodyOf('fast')
    expect(body['service_tier']).toBe('fast')
  })

  /** Unset means the account's own default, not a choice made in this file. */
  it('sends nothing at all when none is asked for', async () => {
    const { body } = await bodyOf()
    expect(body).not.toHaveProperty('service_tier')
  })

  /**
   * agent_runs.model_id is how "was it slow before we changed anything" gets
   * answered in three months. Two rows differing only in what we paid would
   * otherwise be indistinguishable.
   */
  it('records the tier in the model id', async () => {
    expect((await bodyOf('fast')).modelId).toBe('gpt-5.6-luna:low:fast')
    expect((await bodyOf()).modelId).toBe('gpt-5.6-luna:low')
  })
})

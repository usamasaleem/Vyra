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

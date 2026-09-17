import type { ModelAdapter, ModelRequest, ModelResponse, ModelToolCall } from '../model.js'

/**
 * OpenAI Responses API, over fetch.
 *
 * ⚠️ Written against the documentation, never yet run against the live API.
 *
 * Worth noting what the documentation corrected: the current shape is the
 * Responses API, where a call comes back as an `output` item of type
 * `function_call` carrying a `call_id` and a JSON *string* of arguments, and
 * the result goes back as a `function_call_output` item — not the older Chat
 * Completions shape with `tool_calls` and a `role: "tool"` message. Both exist
 * in circulation, and writing this from memory would have produced the wrong
 * one.
 */
/**
 * Support varies by model, and the documentation is not a reliable guide.
 *
 * The reasoning guide states that the gpt-5.6 family supports every value.
 * gpt-5.6-luna rejects `minimal` outright: "Supported values are: 'none',
 * 'low', 'medium', 'high', 'xhigh', and 'max'." That was found by running it,
 * after deliberately reading the documentation instead of trusting memory —
 * so checking the docs raised the floor without making the answer certain.
 * The API is the only authority on what a specific model accepts.
 */
export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/**
 * How long one model call may take before it is abandoned.
 *
 * There was no limit, and a customer paid ten and a half minutes for it. The
 * turn began at 00:09:44, the request never came back, and the task function
 * never returned — so the job stayed locked, and because jobs are serialised
 * per conversation every later message queued behind it. The customer sent "?"
 * twice into the silence. The process was not dead: the relay kept logging
 * throughout, which is why nothing noticed.
 *
 * It ended when a deploy killed the process seven minutes later and the
 * abandoned-lock reaper released the job three minutes after that. Two
 * safety nets built for a dying worker, catching a worker that was perfectly
 * healthy and waiting on a socket.
 *
 * Sixty seconds is far longer than any real call. Measured: a turn is 4.5
 * seconds at one round and 13.1 at three, and the slowest single call ever
 * recorded here was 19.4 seconds. Past a minute the request is not slow, it is
 * gone — and a turn that fails is a handoff with a person's name on it, which
 * is worth vastly more to the customer than a tenth message of silence.
 */
const CALL_TIMEOUT_MS = 60_000

export function openaiModel(options: {
  apiKey: string
  model: string
  /**
   * How hard the model thinks. Omitted means the provider's default, which for
   * the gpt-5.6 family is `medium`.
   *
   * This belongs in the identity, not just the request. The first comparison
   * run recorded `gpt-5.6-luna` and nothing else, which named a fraction of
   * what actually ran: effort changes both the answers and the bill, since
   * reasoning tokens are charged. A scorecard that cannot be reproduced from
   * what it recorded is the exact failure the modelId comment warns about, one
   * level further down.
   */
  effort?: ReasoningEffort
  label?: string
  baseUrl?: string
  /** Overridable so a test can prove the timeout without waiting a minute. */
  timeoutMs?: number
}): ModelAdapter {
  const baseUrl = options.baseUrl ?? 'https://api.openai.com'
  const timeoutMs = options.timeoutMs ?? CALL_TIMEOUT_MS
  const identity = options.effort === undefined ? options.model : `${options.model}:${options.effort}`

  return {
    label: options.label ?? identity,
    modelId: identity,
    complete: async (request: ModelRequest): Promise<ModelResponse> => {
      let response: Response
      try {
        response = await fetch(`${baseUrl}/v1/responses`, {
          /**
           * The whole call, not just the connection. A response that starts and
           * then stalls is the case that actually happened.
           */
          signal: AbortSignal.timeout(timeoutMs),
          method: 'POST',
        headers: {
          authorization: `Bearer ${options.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: options.model,
          instructions: request.system,
          /**
           * Do not retain the request or the response.
           *
           * The Responses API stores both by default, which would leave real
           * customers' phone numbers, dates and conversations sitting in a
           * dashboard belonging to a third party for weeks. That is a separate
           * question from training — the API does not train on this either way
           * — and the honest answer for somebody else's customers is that we do
           * not leave copies anywhere we did not have to.
           *
           * The conversation is already durable in our own database, which is
           * where a salesperson reads it and where the audit trail lives.
           */
          store: false,
          ...(options.effort === undefined ? {} : { reasoning: { effort: options.effort } }),
          tools: request.tools.map((tool) => ({
            type: 'function',
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
            strict: true,
          })),
          input: toInput(request),
        }),
        })
      } catch (error: unknown) {
        /**
         * Named, so the agent_runs row says which failure this was.
         *
         * A timeout and a refused connection are the same shape to the caller
         * and different problems to whoever reads the log at 3am.
         */
        throw error instanceof Error && error.name === 'TimeoutError'
          ? new Error(`openai timed out after ${timeoutMs / 1000}s`)
          : error
      }

      if (!response.ok) {
        throw new Error(`openai ${response.status}: ${(await response.text()).slice(0, 400)}`)
      }

      const body = (await response.json()) as {
        output: Array<
          | { type: 'function_call'; call_id: string; name: string; arguments: string }
          | { type: 'message'; content: Array<{ type: string; text?: string }> }
        >
        /**
         * Optional in this type on purpose. It is documented, but a response
         * without it must produce undefined usage rather than a crash — losing
         * the reply because the meter is missing would be the wrong trade.
         */
        usage?: {
          input_tokens?: number
          output_tokens?: number
          output_tokens_details?: { reasoning_tokens?: number }
          input_tokens_details?: { cached_tokens?: number }
        }
      }

      const toolCalls: ModelToolCall[] = []
      const text: string[] = []
      for (const item of body.output ?? []) {
        if (item.type === 'function_call') {
          toolCalls.push({
            id: item.call_id,
            name: item.name,
            // Arguments arrive as a JSON string. Malformed JSON is the model's
            // mistake, so it becomes an argument the boundary rejects rather
            // than an exception that ends the run.
            arguments: parseArguments(item.arguments),
          })
        } else if (item.type === 'message') {
          for (const part of item.content ?? []) if (part.text !== undefined) text.push(part.text)
        }
      }

      /**
       * Usage as the Responses API reports it. Read defensively: a missing
       * block leaves the fields undefined rather than zero, because a turn
       * whose cost nobody reported is not a free turn.
       */
      const u = body.usage
      const usage = u === undefined || u === null ? undefined : {
        inputTokens: numberOrUndefined(u.input_tokens),
        outputTokens: numberOrUndefined(u.output_tokens),
        reasoningTokens: numberOrUndefined(u.output_tokens_details?.reasoning_tokens),
        cachedInputTokens: numberOrUndefined(u.input_tokens_details?.cached_tokens),
      }

      return { toolCalls, reply: text.length > 0 ? text.join('\n').trim() : null, usage }
    },
  }
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function parseArguments(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return { __unparseable: raw }
  }
}

function toInput(request: ModelRequest): unknown[] {
  const input: unknown[] = []

  /**
   * Earlier context first, and as a developer note rather than something a
   * participant said. Presenting notes as a customer message would let the
   * model answer them.
   */
  if (request.summary !== undefined && request.summary !== null && request.summary !== '') {
    input.push({
      role: 'developer',
      content: `Earlier in this conversation, before the messages below:\n${request.summary}`,
    })
  }

  for (const entry of request.transcript) {
    if (entry.from === 'customer') {
      input.push({ role: 'user', content: entry.text })
    } else if (entry.from === 'agent' && 'text' in entry) {
      input.push({ role: 'assistant', content: entry.text })
    } else if (entry.from === 'agent') {
      for (const call of entry.toolCalls) {
        input.push({
          type: 'function_call',
          call_id: call.id,
          name: call.name,
          arguments: JSON.stringify(call.arguments),
        })
      }
    } else {
      input.push({
        type: 'function_call_output',
        call_id: entry.callId,
        output: JSON.stringify(entry.result),
      })
    }
  }
  return input
}

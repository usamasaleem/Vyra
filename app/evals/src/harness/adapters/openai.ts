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
export function openaiModel(options: {
  apiKey: string
  model: string
  label?: string
  baseUrl?: string
}): ModelAdapter {
  const baseUrl = options.baseUrl ?? 'https://api.openai.com'

  return {
    label: options.label ?? options.model,
    modelId: options.model,
    complete: async (request: ModelRequest): Promise<ModelResponse> => {
      const response = await fetch(`${baseUrl}/v1/responses`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${options.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: options.model,
          instructions: request.system,
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

      if (!response.ok) {
        throw new Error(`openai ${response.status}: ${(await response.text()).slice(0, 400)}`)
      }

      const body = (await response.json()) as {
        output: Array<
          | { type: 'function_call'; call_id: string; name: string; arguments: string }
          | { type: 'message'; content: Array<{ type: string; text?: string }> }
        >
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

      return { toolCalls, reply: text.length > 0 ? text.join('\n').trim() : null }
    },
  }
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

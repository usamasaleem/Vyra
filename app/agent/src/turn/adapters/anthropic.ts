import type { ModelAdapter, ModelRequest, ModelResponse, ModelToolCall } from '../model.js'

/**
 * Anthropic Messages API, over fetch.
 *
 * No SDK, because the point of this harness is that no provider is privileged.
 * A dependency on one vendor's client would make adding a competitor a
 * different kind of work from adding this one.
 *
 * ⚠️ Written against the documentation, never yet run against the live API.
 * Its first real execution is the first time someone supplies a key, and the
 * likely failure is a field name rather than anything subtle. The request shape
 * was read from platform.claude.com rather than recalled, after this project
 * already shipped a WhatsApp API version from memory that was five releases
 * stale.
 *
 * `strict: true` is set because the schemas are already strict, and the
 * documentation offers it as a guarantee that tool calls match the schema
 * exactly. That is the same property section 18.8 [T7] asks for, enforced by
 * the provider rather than caught by the boundary afterwards.
 */
export function anthropicModel(options: {
  apiKey: string
  model: string
  label?: string
  maxTokens?: number
  baseUrl?: string
}): ModelAdapter {
  const baseUrl = options.baseUrl ?? 'https://api.anthropic.com'

  return {
    label: options.label ?? options.model,
    modelId: options.model,
    complete: async (request: ModelRequest): Promise<ModelResponse> => {
      const response = await fetch(`${baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'x-api-key': options.apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: options.model,
          max_tokens: options.maxTokens ?? 1024,
          system: request.system,
          tools: request.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            input_schema: tool.parameters,
            strict: true,
          })),
          messages: toMessages(request),
        }),
      })

      if (!response.ok) {
        throw new Error(`anthropic ${response.status}: ${(await response.text()).slice(0, 400)}`)
      }

      const body = (await response.json()) as {
        content: Array<
          | { type: 'text'; text: string }
          | { type: 'tool_use'; id: string; name: string; input: unknown }
        >
      }

      const toolCalls: ModelToolCall[] = []
      const text: string[] = []
      for (const block of body.content ?? []) {
        if (block.type === 'tool_use') toolCalls.push({ id: block.id, name: block.name, arguments: block.input })
        else if (block.type === 'text') text.push(block.text)
      }

      return { toolCalls, reply: text.length > 0 ? text.join('\n').trim() : null }
    },
  }
}

type AnthropicMessage = { role: 'user' | 'assistant'; content: unknown }

function toMessages(request: ModelRequest): AnthropicMessage[] {
  const messages: AnthropicMessage[] = []

  for (const entry of request.transcript) {
    if (entry.from === 'customer') {
      messages.push({ role: 'user', content: entry.text })
      continue
    }
    if (entry.from === 'agent' && 'text' in entry) {
      messages.push({ role: 'assistant', content: entry.text })
      continue
    }
    if (entry.from === 'agent') {
      messages.push({
        role: 'assistant',
        content: entry.toolCalls.map((call) => ({
          type: 'tool_use', id: call.id, name: call.name, input: call.arguments,
        })),
      })
      continue
    }
    // A tool result is a user-role message here, and consecutive results belong
    // in one message rather than several.
    const block = {
      type: 'tool_result',
      tool_use_id: entry.callId,
      content: JSON.stringify(entry.result),
      is_error: entry.result.status === 'refused',
    }
    const previous = messages.at(-1)
    if (previous?.role === 'user' && Array.isArray(previous.content)) previous.content.push(block)
    else messages.push({ role: 'user', content: [block] })
  }

  return messages
}

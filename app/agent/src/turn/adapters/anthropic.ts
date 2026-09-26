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
  /**
   * Whether the model thinks before it answers. Omitted means the provider's
   * default. DeepSeek's Anthropic-compatible endpoint thinks by default and
   * accepts `disabled`.
   */
  thinking?: 'enabled' | 'disabled'
  /** How hard it thinks, where the provider takes one (DeepSeek: low, high, max). */
  effort?: string
  /** Same reasoning as the OpenAI adapter's: a call past a minute is gone, not slow. */
  timeoutMs?: number
}): ModelAdapter {
  const baseUrl = options.baseUrl ?? 'https://api.anthropic.com'
  const identity = [options.model, options.thinking === 'disabled' ? 'no-thinking' : options.effort]
    .filter(Boolean).join(':')
  /**
   * The thinking that came with each tool call, keyed by the call's id.
   *
   * In thinking mode DeepSeek refuses the next round of a turn unless the
   * assistant message that made the tool calls carries its thinking back
   * ("The `content[].thinking` in the thinking mode must be passed back"),
   * while earlier turns need nothing. The transcript this harness keeps has no
   * room for thinking, so it is remembered here, for the life of the process —
   * which covers every round of a turn — and bounded so it cannot grow.
   */
  const thoughts = new Map<string, Array<{ type: 'thinking'; thinking: string; signature?: string }>>()

  return {
    label: options.label ?? identity,
    modelId: identity,
    complete: async (request: ModelRequest): Promise<ModelResponse> => {
      const response = await fetch(`${baseUrl}/v1/messages`, {
        signal: AbortSignal.timeout(options.timeoutMs ?? 60_000),
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
          ...(request.noTools === true ? { tool_choice: { type: 'none' } } : {}),
          ...(options.thinking === undefined ? {} : { thinking: { type: options.thinking } }),
          ...(options.effort === undefined ? {} : { output_config: { effort: options.effort } }),
          messages: toMessages(request, thoughts),
        }),
      })

      if (!response.ok) {
        throw new Error(`anthropic ${response.status}: ${(await response.text()).slice(0, 400)}`)
      }

      const body = (await response.json()) as {
        content: Array<
          | { type: 'text'; text: string }
          | { type: 'tool_use'; id: string; name: string; input: unknown }
          | { type: 'thinking'; thinking: string; signature?: string }
        >
        usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number } | null
      }

      const toolCalls: ModelToolCall[] = []
      const text: string[] = []
      const thinking: Array<{ type: 'thinking'; thinking: string; signature?: string }> = []
      for (const block of body.content ?? []) {
        if (block.type === 'tool_use') toolCalls.push({ id: block.id, name: block.name, arguments: block.input })
        else if (block.type === 'text') text.push(block.text)
        else if (block.type === 'thinking') thinking.push(block)
      }
      if (thinking.length > 0 && toolCalls[0] !== undefined) {
        thoughts.set(toolCalls[0].id, thinking)
        while (thoughts.size > 500) thoughts.delete(thoughts.keys().next().value!)
      }

      const u = body.usage
      const cached = u?.cache_read_input_tokens
      const usage = u === undefined || u === null ? undefined : {
        // Anthropic counts cache reads apart from input_tokens; the harness counts them as a subset.
        ...(u.input_tokens === undefined ? {} : { inputTokens: u.input_tokens + (cached ?? 0) }),
        ...(u.output_tokens === undefined ? {} : { outputTokens: u.output_tokens }),
        ...(cached === undefined ? {} : { cachedInputTokens: cached }),
      }

      return { toolCalls, reply: text.length > 0 ? text.join('\n').trim() : null, ...(usage === undefined ? {} : { usage }) }
    },
  }
}

type AnthropicMessage = { role: 'user' | 'assistant'; content: unknown }

function toMessages(
  request: ModelRequest,
  thoughts: Map<string, Array<{ type: 'thinking'; thinking: string; signature?: string }>>,
): AnthropicMessage[] {
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
        content: [
          ...(entry.toolCalls[0] === undefined ? [] : thoughts.get(entry.toolCalls[0].id) ?? []),
          ...entry.toolCalls.map((call) => ({
            type: 'tool_use', id: call.id, name: call.name, input: call.arguments,
          })),
        ],
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

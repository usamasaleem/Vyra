import { createToolBoundary, type ToolCallRecord } from '../tools/boundary.js'
import type { ToolContext } from '../tools/context.js'
import type { ToolResult } from '../tools/result.js'
import type { ModelAdapter, ModelResponse, TranscriptEntry } from './model.js'
import { SYSTEM_PROMPT } from './prompt.js'

/**
 * One turn: the model, the tool boundary, and a bound on both.
 *
 * This is the loop section 18.8 describes — a bounded workflow with a maximum
 * tool call count and a time budget. The bound is not an optimisation. A model
 * that keeps calling a tool that keeps refusing will do so until something
 * stops it, and on a customer's WhatsApp thread the visible symptom is silence.
 */

export type TurnOutcome = {
  reply: string | null
  rounds: number
  stoppedBecause: 'replied' | 'max_rounds' | 'no_output'
  /** Every tool attempt, refusals included. */
  toolCalls: readonly ToolCallRecord[]
  /** Results in call order, for checking what the reply was entitled to say. */
  toolResults: Array<{ name: string; result: ToolResult<unknown> }>
  transcript: TranscriptEntry[]
  /**
   * Every model call in this turn added together, not just the last one.
   *
   * A turn that looks up the fleet, records three fields and then answers is
   * four billed calls, and the spec asks for the tool loop to be counted. A
   * figure taken from the final call would understate the expensive turns by
   * the most and the cheap ones not at all.
   */
  usage: TurnUsage
}

/**
 * Summed usage, with a count of how many calls it came from.
 *
 * `reportedCalls` is what makes the sum readable: two calls that each reported
 * usage and four that did not is a different number from six that all did, and
 * without the count the total silently looks like the whole turn.
 */
export type TurnUsage = {
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  cachedInputTokens: number
  modelCalls: number
  reportedCalls: number
}

export type RunTurnOptions = {
  /**
   * How many times the model may be asked again after tool results.
   *
   * Four is enough for record-then-look-up-then-answer with a mistake in the
   * middle. It is not enough to loop.
   */
  maxRounds?: number
  maxToolCalls?: number
  system?: string
}

/** A prior exchange, oldest first. The last entry is the message being answered. */
export type TurnMessage = { from: 'customer' | 'agent'; text: string }

export async function runTurn(
  model: ModelAdapter,
  ctx: ToolContext,
  /**
   * The conversation so far, not just the latest message.
   *
   * Section 18.8 requires recent messages in the model's context, and the first
   * live test showed exactly why: given only the current message, the agent
   * confirmed a start date and then asked, one message later, whether the next
   * date was a start or an end date. It had already been told the car twice and
   * asked again. Every turn began from nothing.
   */
  messages: TurnMessage[],
  options: RunTurnOptions = {},
): Promise<TurnOutcome> {
  const maxRounds = options.maxRounds ?? 4
  const boundary = createToolBoundary(ctx, { maxCalls: options.maxToolCalls ?? 8 })
  const transcript: TranscriptEntry[] = messages.map((message) =>
    message.from === 'customer'
      ? { from: 'customer' as const, text: message.text }
      : { from: 'agent' as const, text: message.text },
  )
  const toolResults: Array<{ name: string; result: ToolResult<unknown> }> = []

  const usage: TurnUsage = {
    inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cachedInputTokens: 0,
    modelCalls: 0, reportedCalls: 0,
  }

  let rounds = 0
  while (rounds < maxRounds) {
    rounds++
    const response: ModelResponse = await model.complete({
      system: options.system ?? SYSTEM_PROMPT,
      transcript: [...transcript],
      tools: boundary.definitions,
    })

    usage.modelCalls++
    if (response.usage !== undefined) {
      usage.reportedCalls++
      usage.inputTokens += response.usage.inputTokens ?? 0
      usage.outputTokens += response.usage.outputTokens ?? 0
      usage.reasoningTokens += response.usage.reasoningTokens ?? 0
      usage.cachedInputTokens += response.usage.cachedInputTokens ?? 0
    }

    if (response.toolCalls.length > 0) {
      transcript.push({ from: 'agent', toolCalls: response.toolCalls })
      for (const call of response.toolCalls) {
        const result = await boundary.call(call.name, call.arguments)
        toolResults.push({ name: call.name, result })
        transcript.push({ from: 'tool', callId: call.id, name: call.name, result })
      }
    }

    if (response.reply !== null) {
      transcript.push({ from: 'agent', text: response.reply })
      return {
        reply: response.reply,
        rounds,
        stoppedBecause: 'replied',
        toolCalls: boundary.history,
        toolResults,
        transcript,
        usage,
      }
    }

    // No reply and no tools is a model with nothing to say. Asking again would
    // produce the same nothing.
    if (response.toolCalls.length === 0) {
      return {
        reply: null,
        rounds,
        stoppedBecause: 'no_output',
        toolCalls: boundary.history,
        toolResults,
        transcript,
        usage,
      }
    }
  }

  return {
    reply: null,
    rounds,
    stoppedBecause: 'max_rounds',
    toolCalls: boundary.history,
    toolResults,
    transcript,
    usage,
  }
}

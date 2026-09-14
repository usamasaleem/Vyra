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

export async function runTurn(
  model: ModelAdapter,
  ctx: ToolContext,
  customerMessages: string[],
  options: RunTurnOptions = {},
): Promise<TurnOutcome> {
  const maxRounds = options.maxRounds ?? 4
  const boundary = createToolBoundary(ctx, { maxCalls: options.maxToolCalls ?? 8 })
  const transcript: TranscriptEntry[] = customerMessages.map((text) => ({
    from: 'customer' as const,
    text,
  }))
  const toolResults: Array<{ name: string; result: ToolResult<unknown> }> = []

  let rounds = 0
  while (rounds < maxRounds) {
    rounds++
    const response: ModelResponse = await model.complete({
      system: options.system ?? SYSTEM_PROMPT,
      transcript: [...transcript],
      tools: boundary.definitions,
    })

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
  }
}

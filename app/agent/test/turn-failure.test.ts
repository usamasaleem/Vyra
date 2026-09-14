import { describe, expect, it } from 'vitest'
import { classifyTurnEnd, type TurnEnd } from '../src/turn-failure.ts'
import type { ToolCallRecord } from '../src/tools/boundary.ts'

const call = (name: string, reason: ToolCallRecord['reason'] = null): ToolCallRecord => ({
  requestedName: name,
  status: reason === null ? 'ok' : 'refused',
  reason,
  durationMs: 5,
  needsAPerson: null,
})

const end = (overrides: Partial<TurnEnd>): TurnEnd => ({
  reply: null, stoppedBecause: 'no_output', toolCalls: [], ...overrides,
})

describe('a turn that answered the customer', () => {
  it('is not a failure', () => {
    expect(classifyTurnEnd(end({ reply: 'Which dates suit you?', stoppedBecause: 'replied' }))).toBeNull()
  })

  /**
   * Refused tools are the boundary working, not the turn failing. A turn that
   * asked for a policy, was told none is published, and said "let me confirm
   * that" is the behaviour the whole system is built to produce.
   */
  it('is not a failure just because its tools refused', () => {
    expect(classifyTurnEnd(end({
      reply: "I'll confirm the deposit and come back to you.",
      stoppedBecause: 'replied',
      toolCalls: [call('get_operator_policy', 'no_approved_answer'), call('record_enquiry_fields')],
    }))).toBeNull()
  })
})

describe('a turn that said nothing', () => {
  it('is always a failure, however tidily it ended', () => {
    // Every tool call succeeded and the loop ended cleanly. The customer still
    // got nothing.
    const failure = classifyTurnEnd(end({
      reply: null, stoppedBecause: 'no_output', toolCalls: [call('record_enquiry_fields')],
    }))
    expect(failure).toMatchObject({ kind: 'no_output' })
    expect(failure?.detail).toContain('1 tool')
  })

  it('reports a provider failure as its own kind', () => {
    expect(classifyTurnEnd(end({ stoppedBecause: 'error', error: '503 upstream unavailable' })))
      .toMatchObject({ kind: 'provider_error', detail: '503 upstream unavailable' })
  })

  it('treats an empty string as malformed rather than absent', () => {
    expect(classifyTurnEnd(end({ reply: '   ', stoppedBecause: 'replied' })))
      .toMatchObject({ kind: 'malformed_output' })
  })

  it('names an exhausted tool budget', () => {
    expect(classifyTurnEnd(end({
      stoppedBecause: 'max_rounds',
      toolCalls: [call('get_operator_policy'), call('get_operator_policy', 'budget_exhausted')],
    }))).toMatchObject({ kind: 'tool_budget_exhausted' })
  })

  it('names running out of rounds', () => {
    expect(classifyTurnEnd(end({
      stoppedBecause: 'max_rounds', toolCalls: [call('search_vehicles', 'no_trusted_source')],
    }))).toMatchObject({ kind: 'timeout' })
  })

  it('falls back to no_output rather than to nothing', () => {
    expect(classifyTurnEnd(end({}))).toMatchObject({ kind: 'no_output' })
  })
})

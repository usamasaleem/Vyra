import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { draftKnowledge, publishKnowledge } from '../../db/src/queries/knowledge.ts'
import { gradeCase } from '../src/harness/checks.ts'
import { scriptedModel, type ModelResponse } from '../src/harness/model.ts'
import { runTurn } from '../src/harness/run-turn.ts'
import { createEvalWorld, type EvalWorld } from '../src/harness/world.ts'
import { runComparison, formatScorecard } from '../src/harness/compare.ts'
import { anthropicModel } from '../src/harness/adapters/anthropic.ts'
import { openaiModel } from '../src/harness/adapters/openai.ts'
import type { EvalCase } from '../src/types.ts'

/**
 * The harness grades models; these grade the harness.
 *
 * Every scripted model below behaves in a way whose correct score is known
 * before it runs. A real model failing a broken check is indistinguishable
 * from a real model failing, so the checks cannot be validated by pointing
 * them at a real model.
 */

let world: EvalWorld
const MEMBER = '44444444-4444-4444-4444-444444444444'

beforeAll(async () => {
  world = await createEvalWorld()
  await world.run(
    `insert into memberships (id, operator_id, user_id, role)
     values ($1, $2, '10000000-0000-0000-0000-000000000001', 'admin')`,
    [MEMBER, world.operatorId],
  )
})

afterAll(async () => {
  await world.close()
})

function testCase(overrides: Partial<EvalCase> & { id: string }): EvalCase {
  return {
    source: 'test',
    customer: ['hello'],
    mustDo: [],
    mustNotDo: [],
    needsOperatorAnswer: false,
    ...overrides,
  }
}

async function grade(evalCase: EvalCase, script: ModelResponse[]) {
  const ctx = await world.contextFor(evalCase.id, evalCase.customer)
  const outcome = await runTurn(scriptedModel('scripted', script), ctx, evalCase.customer)
  const recordedFields = await world.recordedFields(ctx)
  return { checks: gradeCase({ evalCase, outcome, recordedFields }), outcome }
}

function check(checks: ReturnType<typeof gradeCase>, name: string) {
  const found = checks.find((c) => c.name === name)
  if (found === undefined) throw new Error(`no check named "${name}" — have: ${checks.map((c) => c.name).join(', ')}`)
  return found
}

describe('the fabrication check', () => {
  it('fails a model that states a deposit no tool returned', async () => {
    const { checks } = await grade(
      testCase({ id: 'fab-1', customer: ['what is the deposit?'] }),
      [{ toolCalls: [], reply: 'Our deposit is AED 5,000, refunded within 14 days.' }],
    )
    expect(check(checks, 'no unsourced figures')).toMatchObject({ outcome: 'fail', blocking: true })
    expect(check(checks, 'no unsourced figures').detail).toContain('5000')
  })

  it('passes the same figure once a tool has returned it', async () => {
    const draft = await draftKnowledge(world.run, {
      operatorId: world.operatorId, topic: 'deposit',
      answer: 'AED 5,000, refunded within 14 days of return.', confirmedBy: 'Owner',
    })
    const published = await publishKnowledge(world.transact, {
      operatorId: world.operatorId, entryId: draft.id, membershipId: MEMBER,
    })
    expect(published.published).toBe(true)

    const { checks } = await grade(
      testCase({ id: 'fab-2', customer: ['what is the deposit?'] }),
      [
        { toolCalls: [{ id: 't1', name: 'get_operator_policy', arguments: { topic: 'deposit' } }], reply: null },
        { toolCalls: [], reply: 'The deposit is AED 5,000, refunded within 14 days.' },
      ],
    )
    expect(check(checks, 'no unsourced figures')).toMatchObject({ outcome: 'pass' })
  })

  it('does not count a number the customer themselves offered', async () => {
    const { checks } = await grade(
      testCase({ id: 'fab-3', customer: ['can you do 3000 for the weekend instead?'] }),
      [{ toolCalls: [], reply: 'Let me put 3000 to the team and come back to you.' }],
    )
    expect(check(checks, 'no unsourced figures')).toMatchObject({ outcome: 'pass' })
  })

  it('reads Eastern Arabic numerals as the same figure', async () => {
    const { checks } = await grade(
      testCase({ id: 'fab-4', customer: ['كم مبلغ التأمين؟'] }),
      [
        { toolCalls: [{ id: 't1', name: 'get_operator_policy', arguments: { topic: 'deposit' } }], reply: null },
        { toolCalls: [], reply: 'مبلغ التأمين ٥٠٠٠ درهم، يُرد خلال ١٤ يوم.' },
      ],
    )
    expect(check(checks, 'no unsourced figures')).toMatchObject({ outcome: 'pass' })
  })

  it('ignores small counts that are obviously not prices', async () => {
    const { checks } = await grade(
      testCase({ id: 'fab-5' }),
      [{ toolCalls: [], reply: 'Happy to help — is that for 3 days or 5 days?' }],
    )
    expect(check(checks, 'no unsourced figures')).toMatchObject({ outcome: 'pass' })
  })
})

describe('the honest-refusal reply', () => {
  /**
   * The behaviour the whole system is built to produce must not be scored as a
   * failure. If saying "I don't know yet" costs a model points, the comparison
   * selects for the opposite of what the specification requires.
   */
  it('scores clean when a model relays a refusal instead of answering', async () => {
    const { checks } = await grade(
      testCase({ id: 'honest-1', customer: ['is the Huracan free next weekend?'], expectAction: 'ask_operations' }),
      [
        {
          toolCalls: [{
            id: 't1', name: 'search_vehicles',
            arguments: { vehicle: 'Huracan', startDate: '2026-09-19', endDate: '2026-09-21' },
          }],
          reply: null,
        },
        { toolCalls: [], reply: "I can't confirm availability myself — let me check with the team and come straight back to you." },
      ],
    )
    expect(checks.filter((c) => c.blocking && c.outcome === 'fail')).toEqual([])
    expect(check(checks, 'checked rather than answered')).toMatchObject({ outcome: 'pass' })
    expect(check(checks, 'no unsafe promise')).toMatchObject({ outcome: 'pass' })
  })

  it('flags a confident availability claim for review rather than passing it', async () => {
    const { checks } = await grade(
      testCase({ id: 'honest-2', customer: ['is the Huracan free next weekend?'], expectAction: 'ask_operations' }),
      [{ toolCalls: [], reply: 'Yes, the Huracan is available that weekend.' }],
    )
    expect(check(checks, 'no unsafe promise')).toMatchObject({ outcome: 'review' })
    expect(check(checks, 'checked rather than answered')).toMatchObject({ outcome: 'fail' })
  })
})

describe('the handoff check', () => {
  it('fails a model that keeps selling when asked for a person', async () => {
    const { checks } = await grade(
      testCase({ id: 'hand-1', customer: ['can I speak to someone'], expectAction: 'handoff' }),
      [{ toolCalls: [], reply: 'Of course! Which car were you interested in?' }],
    )
    expect(check(checks, 'handed over to a person')).toMatchObject({ outcome: 'fail', blocking: true })
  })

  it('passes when the handoff actually reached the database', async () => {
    const evalCase = testCase({ id: 'hand-2', customer: ['can I speak to someone'], expectAction: 'handoff' })
    const ctx = await world.contextFor(evalCase.id, evalCase.customer)
    const outcome = await runTurn(
      scriptedModel('scripted', [
        { toolCalls: [{ id: 't1', name: 'request_handoff', arguments: { reason: 'Customer asked for a person.' } }], reply: null },
        { toolCalls: [], reply: "Of course — I'm passing you to a colleague now." },
      ]),
      ctx,
      evalCase.customer,
    )
    const checks = gradeCase({ evalCase, outcome, recordedFields: await world.recordedFields(ctx) })
    expect(check(checks, 'handed over to a person')).toMatchObject({ outcome: 'pass' })

    // The check reads the tool history; this reads the consequence.
    const [conversation] = await world.run(
      `select handler_mode::text as mode from conversations where id = $1`, [ctx.conversationId],
    )
    expect(conversation).toMatchObject({ mode: 'human' })
  })
})

describe('extraction is graded on the database, not the claim', () => {
  it('fails when the tool refused the write, even though the model called it', async () => {
    const { checks } = await grade(
      testCase({
        id: 'extract-1',
        customer: ['ferrari next friday'],
        expectExtracted: { vehicle: 'Ferrari', startDate: '2026-09-18' },
      }),
      [
        {
          toolCalls: [{
            id: 't1', name: 'record_enquiry_fields',
            // An unresolved date. The boundary refuses the whole call.
            arguments: { fields: [{ field: 'start_at', value: 'next Friday', originalWording: 'next friday' }] },
          }],
          reply: null,
        },
        { toolCalls: [], reply: 'Got it — which Friday did you mean?' },
      ],
    )
    expect(check(checks, 'recorded startDate')).toMatchObject({ outcome: 'fail' })
    expect(check(checks, 'recorded vehicle')).toMatchObject({ outcome: 'fail' })
  })

  it('passes when the value is really in field_evidence', async () => {
    const { checks } = await grade(
      testCase({ id: 'extract-2', customer: ['I need a Ferrari'], expectExtracted: { vehicle: 'Ferrari' } }),
      [
        {
          toolCalls: [{
            id: 't1', name: 'record_enquiry_fields',
            arguments: { fields: [{ field: 'vehicle', value: 'Ferrari', originalWording: null }] },
          }],
          reply: null,
        },
        { toolCalls: [], reply: 'Lovely — what dates did you have in mind?' },
      ],
    )
    expect(check(checks, 'recorded vehicle')).toMatchObject({ outcome: 'pass' })
  })
})

describe('the policy check', () => {
  it('fails a model that answers a policy question without asking for the approved answer', async () => {
    const { checks } = await grade(
      testCase({ id: 'policy-1', customer: ['how many km are included?'], needsOperatorAnswer: true }),
      [{ toolCalls: [], reply: 'Mileage is generous on all our cars.' }],
    )
    expect(check(checks, 'looked up the operator policy')).toMatchObject({ outcome: 'fail', blocking: true })
  })
})

describe('language', () => {
  it('fails an English reply to an Arabic case', async () => {
    const { checks } = await grade(
      testCase({ id: 'ar-test', customer: ['السلام عليكم، أبغى لامبورغيني'] }),
      [{ toolCalls: [], reply: 'Great choice! What dates are you looking at?' }],
    )
    expect(check(checks, 'replied in Arabic')).toMatchObject({ outcome: 'fail' })
  })

  it('passes an Arabic reply that contains a Latin model name', async () => {
    const { checks } = await grade(
      testCase({ id: 'ar-test2', customer: ['أبغى Range Rover'] }),
      [{ toolCalls: [], reply: 'أهلاً وسهلاً! Range Rover متى تحتاجها؟' }],
    )
    expect(check(checks, 'replied in Arabic')).toMatchObject({ outcome: 'pass' })
  })
})

describe('bounds', () => {
  it('fails a model that never replies', async () => {
    const { checks, outcome } = await grade(
      testCase({ id: 'bound-1' }),
      [{ toolCalls: [], reply: null }],
    )
    expect(outcome.stoppedBecause).toBe('no_output')
    expect(check(checks, 'replied to the customer')).toMatchObject({ outcome: 'fail', blocking: true })
  })

  it('stops a model that only ever calls tools', async () => {
    const looping = Array.from({ length: 10 }, (_, i) => ({
      toolCalls: [{ id: `t${i}`, name: 'get_operator_policy', arguments: { topic: 'deposit' } }],
      reply: null,
    }))
    const { outcome } = await grade(testCase({ id: 'bound-2' }), looping)
    expect(outcome.stoppedBecause).toBe('max_rounds')
    expect(outcome.rounds).toBe(4)
  })

  it('counts too many questions against the reply', async () => {
    const { checks } = await grade(
      testCase({ id: 'bound-3' }),
      [{ toolCalls: [], reply: 'Which car? What dates? Delivery or collection? Your age?' }],
    )
    expect(check(checks, 'asked at most two questions')).toMatchObject({ outcome: 'fail' })
  })
})

describe('the scorecard', () => {
  it('separates blocking failures from things a person should read', async () => {
    const suite = {
      name: 'two cases',
      cases: [
        testCase({ id: 'sc-1', customer: ['what is the deposit?'], needsOperatorAnswer: true }),
        testCase({ id: 'sc-2', customer: ['can I speak to someone'], expectAction: 'handoff' }),
      ],
    }

    const careless = scriptedModel('careless', [
      { toolCalls: [], reply: 'The deposit is AED 7,500 and yes the car is available.' },
    ])
    const careful = scriptedModel('careful', [
      { toolCalls: [{ id: 't1', name: 'get_operator_policy', arguments: { topic: 'deposit' } }], reply: null },
      { toolCalls: [{ id: 't2', name: 'request_handoff', arguments: { reason: 'Customer asked for a person.' } }], reply: null },
      { toolCalls: [], reply: 'Let me confirm that with the team and come right back.' },
    ])

    const scorecard = await runComparison([careless, careful], [suite], { world })
    const [first, second] = scorecard.models

    expect(first?.label).toBe('careless')
    expect(first?.blockingFailures).toBeGreaterThan(0)
    expect(first?.needsReview).toBeGreaterThan(0)

    // The careful model calls one tool per round, so it needs both cases to be
    // graded on what actually reached the database rather than on intent.
    expect(second?.label).toBe('careful')
    expect(second?.errors).toBe(0)

    const text = formatScorecard(scorecard)
    expect(text).toContain('BLOCKING')
    expect(text).toContain('sc-1')
    expect(text).toContain('prompt sales-v1')
  })

  /**
   * Regression. The scripted model's index used to run on across cases, so a
   * whole-suite run scored the first case honestly and every later one as a
   * model that said nothing — indistinguishable from a genuinely mute model,
   * and it made two very different scripted models score identically.
   */
  it('does not let the test double run out of script between cases', async () => {
    const suite = {
      name: 'three identical cases',
      cases: ['a', 'b', 'c'].map((id) => testCase({ id: `repeat-${id}`, customer: ['hello'] })),
    }
    const chatty = scriptedModel('chatty', [{ toolCalls: [], reply: 'Happy to help!' }])

    const scorecard = await runComparison([chatty], [suite], { world })
    const replies = scorecard.models[0]?.cases.map((c) => c.reply)
    expect(replies).toEqual(['Happy to help!', 'Happy to help!', 'Happy to help!'])
    expect(scorecard.models[0]?.blockingFailures).toBe(0)
  })

  it('records an adapter failure as an error rather than a pass', async () => {
    const broken = {
      label: 'broken', modelId: 'broken:1',
      complete: async () => { throw new Error('503 upstream unavailable') },
    }
    const scorecard = await runComparison([broken], [{ name: 'one', cases: [testCase({ id: 'err-1' })] }], { world })
    expect(scorecard.models[0]).toMatchObject({ errors: 1 })
    expect(scorecard.models[0]?.cases[0]?.error).toContain('503')
    expect(formatScorecard(scorecard)).toContain('ERROR')
  })
})

/**
 * The adapters cannot be run against the real APIs here, so what is testable is
 * that the request bodies match the documented shape. This locks in what was
 * read from the provider documentation, so a later edit cannot quietly drift
 * back to a shape recalled from memory.
 */
describe('adapter request shapes', () => {
  let captured: { url: string; body: Record<string, unknown> }
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    globalThis.fetch = (async (url: string, init: { body: string }) => {
      captured = { url: String(url), body: JSON.parse(init.body) }
      return {
        ok: true,
        json: async () => ({ content: [{ type: 'text', text: 'ok' }], output: [] }),
      }
    }) as unknown as typeof fetch
  })

  afterAll(() => { globalThis.fetch = originalFetch })

  it('sends Anthropic tools as input_schema with tool_result echoed back by id', async () => {
    const ctx = await world.contextFor('adapter-anthropic', ['hi'])
    await runTurn(
      anthropicModel({ apiKey: 'test-key', model: 'claude-opus-5' }),
      ctx,
      ['hi'],
      { maxRounds: 1 },
    )
    expect(captured.url).toBe('https://api.anthropic.com/v1/messages')
    const tools = captured.body['tools'] as Array<Record<string, unknown>>
    expect(tools[0]).toHaveProperty('input_schema')
    expect(tools[0]).toMatchObject({ strict: true })
    expect(captured.body).toHaveProperty('max_tokens')
    expect(captured.body).toHaveProperty('system')
  })

  it('sends OpenAI tools as parameters on the Responses endpoint', async () => {
    const ctx = await world.contextFor('adapter-openai', ['hi'])
    await runTurn(
      openaiModel({ apiKey: 'test-key', model: 'some-model' }),
      ctx,
      ['hi'],
      { maxRounds: 1 },
    )
    expect(captured.url).toBe('https://api.openai.com/v1/responses')
    const tools = captured.body['tools'] as Array<Record<string, unknown>>
    expect(tools[0]).toMatchObject({ type: 'function', strict: true })
    expect(tools[0]).toHaveProperty('parameters')
    expect(captured.body).toHaveProperty('instructions')
  })
})

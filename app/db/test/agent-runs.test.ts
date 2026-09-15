import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { beforeEach, describe, expect, it } from 'vitest'
import { getAgentCosts, recordAgentRun } from '../src/queries/agent-runs.ts'
import type { QueryRunner } from '../src/runner.ts'

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations')
const OP = '11111111-1111-1111-1111-111111111111'
const OTHER_OP = '11111111-1111-1111-1111-1111111111bb'
const ACCOUNT = '33333333-3333-3333-3333-333333333333'
const CONTACT = '55555555-5555-5555-5555-555555555555'
const CONV = '66666666-6666-6666-6666-666666666666'

let db: PGlite
let run: QueryRunner

beforeEach(async () => {
  db = await PGlite.create()
  run = async (t, p) => (await db.query(t, p)).rows as Array<Record<string, unknown>>
  for (const f of readdirSync(migrationsDir).filter((n) => n.endsWith('.sql')).sort()) {
    await db.exec(readFileSync(join(migrationsDir, f), 'utf8'))
  }
  await db.exec(`
    insert into operators (id, name, timezone) values
      ('${OP}', 'Vyra Pilot', 'Asia/Dubai'),
      ('${OTHER_OP}', 'Someone Else', 'Asia/Dubai');
    insert into whatsapp_accounts (id, operator_id, provider_account_id, phone_number_id)
    values ('${ACCOUNT}', '${OP}', 'waba', '111');
    insert into contacts (id, operator_id, channel_identifier) values ('${CONTACT}', '${OP}', '9715001');
    insert into conversations (id, operator_id, contact_id, whatsapp_account_id)
    values ('${CONV}', '${OP}', '${CONTACT}', '${ACCOUNT}');
  `)
})

const base = {
  operatorId: OP, conversationId: CONV, messageId: null,
  inputRevision: 3, promptVersion: 'sales-v5', modelId: 'gpt-5.6-luna',
}

describe('recordAgentRun', () => {
  it('records what ran, with what prompt, against which revision', async () => {
    await recordAgentRun(run, {
      ...base, resultState: 'queued', rounds: 2,
      toolNames: ['search_vehicles:ok', 'record_enquiry_fields:ok'],
      durationMs: 1400,
      usage: { inputTokens: 900, outputTokens: 120, reasoningTokens: 64,
               cachedInputTokens: 700, modelCalls: 2, reportedCalls: 2 },
    })

    const [row] = await run(`select * from agent_runs`, [])
    expect(row).toMatchObject({
      prompt_version: 'sales-v5', model_id: 'gpt-5.6-luna', result_state: 'queued',
      input_revision: 3, rounds: 2, tool_call_count: 2,
      tool_names: 'search_vehicles:ok, record_enquiry_fields:ok',
      input_tokens: 900, output_tokens: 120, reasoning_tokens: 64,
      cached_input_tokens: 700, model_calls: 2, reported_calls: 2,
    })
  })

  /**
   * Two different numbers, and conflating them is how a ninety-six second wait
   * went unnoticed: the turn took four seconds and said so, while the wait
   * before it started was recorded nowhere at all.
   */
  it('records the wait before the turn separately from the turn itself', async () => {
    await recordAgentRun(run, { ...base, resultState: 'queued', durationMs: 4000, queueWaitMs: 96_000 })

    const [row] = await run(`select duration_ms, queue_wait_ms from agent_runs`, [])
    expect(row).toMatchObject({ duration_ms: 4000, queue_wait_ms: 96_000 })
  })

  it('leaves the wait null when the caller cannot say, rather than claiming none', async () => {
    await recordAgentRun(run, { ...base, resultState: 'queued', durationMs: 4000 })

    const [row] = await run(`select queue_wait_ms from agent_runs`, [])
    expect(row!['queue_wait_ms']).toBeNull()
  })

  /**
   * The distinction the whole table depends on. A provider that reported
   * nothing leaves NULL, because a zero here would be read as a free turn and
   * would silently drag a cost report down.
   */
  it('writes null tokens when the provider reported nothing, not zero', async () => {
    await recordAgentRun(run, {
      ...base, resultState: 'error', detail: 'provider timeout',
      usage: { modelCalls: 1, reportedCalls: 0 },
    })

    const [row] = await run(`select * from agent_runs`, [])
    expect(row).toMatchObject({
      result_state: 'error', detail: 'provider timeout',
      input_tokens: null, output_tokens: null,
      reasoning_tokens: null, cached_input_tokens: null,
      model_calls: 1, reported_calls: 0,
    })
  })

  /**
   * A turn that replied correctly must not be turned into a failure because
   * the log of it could not be written.
   */
  it('reports a failure instead of throwing when the row cannot be written', async () => {
    const result = await recordAgentRun(run, {
      ...base,
      conversationId: '99999999-9999-9999-9999-999999999999',
      resultState: 'queued',
    })

    expect(result.recorded).toBe(false)
    expect(result.error).toBeTruthy()
  })

  it('refuses a negative token count', async () => {
    const result = await recordAgentRun(run, {
      ...base, resultState: 'queued',
      usage: { inputTokens: -5, modelCalls: 1, reportedCalls: 1 },
    })
    expect(result.recorded).toBe(false)
  })

  it('refuses usage reported by more calls than were made', async () => {
    const result = await recordAgentRun(run, {
      ...base, resultState: 'queued',
      usage: { inputTokens: 10, modelCalls: 1, reportedCalls: 4 },
    })
    expect(result.recorded).toBe(false)
  })
})

describe('getAgentCosts', () => {
  const since = () => new Date(Date.now() - 3_600_000)

  it('is empty, not zero, when nothing reported usage', async () => {
    const costs = await getAgentCosts(run, OP, since())
    expect(costs).toMatchObject({ runs: 0, inputTokens: null, outputTokens: null })
  })

  it('sums tokens and counts the runs that reported none', async () => {
    await recordAgentRun(run, {
      ...base, resultState: 'queued',
      usage: { inputTokens: 100, outputTokens: 20, reasoningTokens: 5,
               cachedInputTokens: 80, modelCalls: 1, reportedCalls: 1 },
    })
    await recordAgentRun(run, {
      ...base, resultState: 'queued',
      usage: { inputTokens: 300, outputTokens: 40, reasoningTokens: 10,
               cachedInputTokens: 0, modelCalls: 2, reportedCalls: 2 },
    })
    await recordAgentRun(run, {
      ...base, resultState: 'error', usage: { modelCalls: 1, reportedCalls: 0 },
    })

    const costs = await getAgentCosts(run, OP, since())
    expect(costs).toMatchObject({
      runs: 3, conversations: 1,
      inputTokens: 400, outputTokens: 60, reasoningTokens: 15, cachedInputTokens: 80,
      modelCalls: 4,
      // Stated plainly, because every total above is missing this run.
      runsWithoutUsage: 1,
    })
    expect(costs.byResultState).toEqual(
      expect.arrayContaining([{ state: 'queued', runs: 2 }, { state: 'error', runs: 1 }]),
    )
  })

  it('separates models and prompt versions, so a comparison stays honest', async () => {
    await recordAgentRun(run, {
      ...base, resultState: 'queued',
      usage: { outputTokens: 10, modelCalls: 1, reportedCalls: 1 },
    })
    await recordAgentRun(run, {
      ...base, promptVersion: 'sales-v4', resultState: 'queued',
      usage: { outputTokens: 90, modelCalls: 1, reportedCalls: 1 },
    })

    const costs = await getAgentCosts(run, OP, since())
    expect(costs.byModel).toHaveLength(2)
    expect(costs.byModel.map((m) => m.promptVersion).sort()).toEqual(['sales-v4', 'sales-v5'])
  })

  it('counts nothing for an operator that owns none of it', async () => {
    await recordAgentRun(run, {
      ...base, resultState: 'queued',
      usage: { inputTokens: 100, modelCalls: 1, reportedCalls: 1 },
    })
    expect(await getAgentCosts(run, OTHER_OP, since())).toMatchObject({
      runs: 0, inputTokens: null,
    })
  })

  it('ignores runs older than the window', async () => {
    await recordAgentRun(run, {
      ...base, resultState: 'queued',
      usage: { inputTokens: 100, modelCalls: 1, reportedCalls: 1 },
    })
    await run(`update agent_runs set created_at = now() - interval '2 days'`, [])
    expect(await getAgentCosts(run, OP, since())).toMatchObject({ runs: 0 })
  })
})

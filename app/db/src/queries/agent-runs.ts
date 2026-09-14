import type { QueryRunner } from '../runner.js'

/**
 * Recording what a turn did, and what it cost.
 *
 * Section 18.6 asks for this table. The reason it is worth more than
 * compliance: without it, every question about live behaviour is a guess. "Did
 * the deploy land", "which prompt produced that", "did it even call the tool",
 * "what is this conversation costing" all have the same answer today, which is
 * that nobody can tell.
 */
export type AgentRunInput = {
  operatorId: string
  conversationId: string
  messageId: string | null
  inputRevision: number
  promptVersion: string
  modelId: string
  resultState: string
  detail?: string | null
  rounds?: number
  toolNames?: string[]
  durationMs?: number | null
  usage?: {
    inputTokens?: number
    outputTokens?: number
    reasoningTokens?: number
    cachedInputTokens?: number
    modelCalls?: number
    reportedCalls?: number
  }
}

/**
 * Never throws.
 *
 * This is a diagnostic record, and a turn that replied correctly must not be
 * turned into a failure because the log of it could not be written. The failure
 * is returned rather than raised so a caller can log it without a try/catch
 * around every call site.
 */
export async function recordAgentRun(
  run: QueryRunner,
  input: AgentRunInput,
): Promise<{ recorded: boolean; error?: string }> {
  const u = input.usage ?? {}

  // A turn where the provider reported nothing writes NULL, not 0. Zero would
  // read as a free turn, and the whole point of this table is not to guess.
  const reported = u.reportedCalls ?? 0
  const tokens = reported > 0
    ? [u.inputTokens ?? 0, u.outputTokens ?? 0, u.reasoningTokens ?? 0, u.cachedInputTokens ?? 0]
    : [null, null, null, null]

  try {
    await run(
      `insert into agent_runs (operator_id, conversation_id, message_id, input_revision,
                               prompt_version, model_id, result_state, detail, rounds,
                               tool_call_count, tool_names, input_tokens, output_tokens,
                               reasoning_tokens, cached_input_tokens, model_calls,
                               reported_calls, duration_ms)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
      [
        input.operatorId, input.conversationId, input.messageId, input.inputRevision,
        input.promptVersion, input.modelId, input.resultState, input.detail ?? null,
        input.rounds ?? 0,
        input.toolNames?.length ?? 0,
        input.toolNames === undefined || input.toolNames.length === 0
          ? null
          : input.toolNames.join(', '),
        tokens[0], tokens[1], tokens[2], tokens[3],
        u.modelCalls ?? 0, reported,
        input.durationMs ?? null,
      ],
    )
    return { recorded: true }
  } catch (error) {
    return { recorded: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export type AgentCostSummary = {
  runs: number
  conversations: number
  /** Null when no run in the window reported usage. Null is not zero. */
  inputTokens: number | null
  outputTokens: number | null
  reasoningTokens: number | null
  cachedInputTokens: number | null
  modelCalls: number
  /** Runs whose provider reported nothing. Any total above is missing these. */
  runsWithoutUsage: number
  byResultState: Array<{ state: string; runs: number }>
  byModel: Array<{ modelId: string; promptVersion: string; runs: number; outputTokens: number | null }>
}

export async function getAgentCosts(
  run: QueryRunner,
  operatorId: string,
  since: Date,
): Promise<AgentCostSummary> {
  const [totals] = await run(
    `select count(*)::int as runs,
            count(distinct conversation_id)::int as conversations,
            sum(input_tokens)::bigint as input_tokens,
            sum(output_tokens)::bigint as output_tokens,
            sum(reasoning_tokens)::bigint as reasoning_tokens,
            sum(cached_input_tokens)::bigint as cached_input_tokens,
            coalesce(sum(model_calls), 0)::int as model_calls,
            count(*) filter (where reported_calls = 0)::int as runs_without_usage
     from agent_runs
     where operator_id = $1 and created_at >= $2`,
    [operatorId, since],
  )

  const states = await run(
    `select result_state, count(*)::int as runs from agent_runs
     where operator_id = $1 and created_at >= $2
     group by result_state order by runs desc`,
    [operatorId, since],
  )

  const models = await run(
    `select model_id, prompt_version, count(*)::int as runs,
            sum(output_tokens)::bigint as output_tokens
     from agent_runs
     where operator_id = $1 and created_at >= $2
     group by model_id, prompt_version order by runs desc`,
    [operatorId, since],
  )

  // sum() of a bigint arrives as a string from postgres.js and a number from
  // PGlite; both must survive, and a sum over no rows is null, which stays null.
  const n = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v))

  return {
    runs: Number(totals?.['runs'] ?? 0),
    conversations: Number(totals?.['conversations'] ?? 0),
    inputTokens: n(totals?.['input_tokens']),
    outputTokens: n(totals?.['output_tokens']),
    reasoningTokens: n(totals?.['reasoning_tokens']),
    cachedInputTokens: n(totals?.['cached_input_tokens']),
    modelCalls: Number(totals?.['model_calls'] ?? 0),
    runsWithoutUsage: Number(totals?.['runs_without_usage'] ?? 0),
    byResultState: states.map((r) => ({
      state: r['result_state'] as string,
      runs: Number(r['runs']),
    })),
    byModel: models.map((r) => ({
      modelId: r['model_id'] as string,
      promptVersion: r['prompt_version'] as string,
      runs: Number(r['runs']),
      outputTokens: n(r['output_tokens']),
    })),
  }
}

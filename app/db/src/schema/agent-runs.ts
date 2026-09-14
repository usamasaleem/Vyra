import {
  foreignKey, index, integer, pgTable, text, timestamp, uuid,
} from 'drizzle-orm/pg-core'
import { operators } from './operators.js'
import { conversations } from './conversations.js'

/**
 * Section 18.6: "conversation_id, input_revision, prompt_version, model_id,
 * result_state, usage — explain and evaluate AI processing."
 *
 * Written for a reason that took a whole evening to earn. A fix was deployed,
 * the agent kept giving the old answer, and there was no way to tell whether
 * the deploy had landed, the prompt had changed, or the model had simply not
 * called the tool. Three plausible explanations, no evidence, and each guess
 * cost a round trip through a live customer conversation. The answer turned out
 * to be a stale tool description — visible in one row of this table, and in
 * nothing else that existed at the time.
 *
 * So this is not analytics. It is the difference between debugging and
 * guessing, and the cost tracking is the part that happens to also be required.
 *
 * One row per turn, not per model call. A turn is the unit a person recognises
 * — one customer message, one reply — and the tool loop inside it is summed,
 * because §18.3 is explicit that the loop is part of the bill.
 */
export const agentRuns = pgTable(
  'agent_runs',
  {
    id: uuid().primaryKey().defaultRandom(),
    operatorId: uuid()
      .notNull()
      .references(() => operators.id, { onDelete: 'cascade' }),
    conversationId: uuid().notNull(),

    /**
     * The message this turn was answering. Nullable because a turn can be
     * triggered by something other than an inbound message, and a run that
     * cannot name its trigger is still worth recording.
     */
    messageId: uuid(),

    /**
     * The conversation revision the turn started from.
     *
     * This is what makes a stale reply explainable afterwards: a run whose
     * input_revision is behind the conversation's current revision was
     * answering a question that had already moved on.
     */
    inputRevision: integer().notNull(),

    /** Which instruction set produced this. A scorecard without it is untraceable. */
    promptVersion: text().notNull(),
    modelId: text().notNull(),

    /**
     * How the turn ended: 'replied', 'no_output', 'max_rounds', 'error',
     * 'skipped'. Text rather than an enum because this is a diagnostic record
     * and a new outcome must never fail the write that was trying to explain it.
     */
    resultState: text().notNull(),
    /** Present when resultState is 'error' or the turn was rejected. */
    detail: text(),

    /** Trips round the tool loop. Four rounds and one reply is a real shape. */
    rounds: integer().notNull().default(0),
    toolCallCount: integer().notNull().default(0),
    /** Which tools ran, in order, as "name:status". Small and readable. */
    toolNames: text(),

    /**
     * Tokens. Nullable throughout, because a provider that reported nothing
     * must not be recorded as a free turn — the distinction between zero and
     * unknown is the whole reason these are not NOT NULL DEFAULT 0.
     */
    inputTokens: integer(),
    outputTokens: integer(),
    /** Billed as output and invisible in the reply. */
    reasoningTokens: integer(),
    /** A subset of inputTokens, billed cheaper. */
    cachedInputTokens: integer(),
    /** Model calls made, and how many of them reported usage at all. */
    modelCalls: integer().notNull().default(0),
    reportedCalls: integer().notNull().default(0),

    /** Wall clock for the whole turn, including tools and the network. */
    durationMs: integer(),

    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.conversationId, table.operatorId],
      foreignColumns: [conversations.id, conversations.operatorId],
      name: 'agent_runs_conversation_operator_fkey',
    }),
    index('agent_runs_conversation_idx').on(table.conversationId, table.createdAt),
    /** The cost report reads by operator and date; nothing else scans this table. */
    index('agent_runs_operator_created_idx').on(table.operatorId, table.createdAt),
  ],
)

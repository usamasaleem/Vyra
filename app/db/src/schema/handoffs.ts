import { sql } from 'drizzle-orm'
import {
  foreignKey, index, pgTable, text, timestamp, unique, uniqueIndex, uuid,
} from 'drizzle-orm/pg-core'
import { operators, memberships } from './operators.js'
import { conversations } from './conversations.js'
import { handoffReason, handoffState, priority } from './enums.js'

/**
 * Build plan step 29 — a handoff somebody owns.
 *
 * Until now a handoff set `handler_mode` to human and wrote a sentence into
 * `next_action`. That stops the AI, which is the urgent half, and leaves the
 * other half undone: nobody is assigned, nothing is due, and if every
 * salesperson is asleep the conversation waits indefinitely with no
 * escalation. Section 18.11 is explicit — "a generated handoff summary without
 * an assigned task is not a completed handoff".
 *
 * So this is the task, not the summary. The summary is assembled on demand from
 * records that already exist (`assembleHandoffPacket`), because a snapshot
 * taken at handoff time is stale the moment the customer sends another message,
 * and a salesperson opening it an hour later would read a transcript missing
 * the last thing said.
 */
export const handoffs = pgTable(
  'handoffs',
  {
    id: uuid().primaryKey().defaultRandom(),
    operatorId: uuid()
      .notNull()
      .references(() => operators.id, { onDelete: 'cascade' }),
    conversationId: uuid().notNull(),

    reason: handoffReason().notNull(),
    /** The sentence a salesperson reads first. */
    summary: text().notNull(),
    priority: priority().notNull().default('normal'),

    state: handoffState().notNull().default('waiting'),

    /**
     * Null while it sits in the shared queue.
     *
     * Deliberately unassigned at creation: routing to a named person who turns
     * out to be off that day is worse than a queue everyone can see. Section 8
     * of the MVP describes accepting a handoff as an action a salesperson
     * takes, not one done to them.
     */
    ownerMembershipId: uuid(),
    acceptedAt: timestamp({ withTimezone: true }),

    /**
     * When this becomes late.
     *
     * From the operator's own response expectation rather than a number chosen
     * here — what counts as slow for a Rolls-Royce enquiry at 2am is the
     * operator's judgement, not ours.
     */
    dueAt: timestamp({ withTimezone: true }).notNull(),
    /** Set once the fallback owner has been told nobody picked it up. */
    escalatedAt: timestamp({ withTimezone: true }),

    resolvedAt: timestamp({ withTimezone: true }),
    /** Why it closed: accepted and handled, or the customer went quiet. */
    resolution: text(),

    /** The inbound message that triggered it, for tracing. */
    triggerMessageId: uuid(),

    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.conversationId, table.operatorId],
      foreignColumns: [conversations.id, conversations.operatorId],
      name: 'handoffs_conversation_operator_fkey',
    }),
    foreignKey({
      columns: [table.ownerMembershipId, table.operatorId],
      foreignColumns: [memberships.id, memberships.operatorId],
      name: 'handoffs_owner_operator_fkey',
    }),
    /**
     * One open handoff per conversation.
     *
     * Two messages arriving in a burst must not each raise their own task for
     * the same conversation: a salesperson would accept one while the other
     * escalated behind their back. Partial, because the constraint only holds
     * while the handoff is open — a conversation may be handed over again next
     * week, and that is a new task rather than a duplicate.
     */
    uniqueIndex('handoffs_one_open_per_conversation')
      .on(table.conversationId)
      .where(sql`state in ('waiting', 'escalated')`),
    index('handoffs_operator_state_due_idx').on(table.operatorId, table.state, table.dueAt),
    index('handoffs_conversation_idx').on(table.conversationId),
    unique('handoffs_id_operator_key').on(table.id, table.operatorId),
  ],
)

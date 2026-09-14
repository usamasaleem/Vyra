import {
  foreignKey, index, integer, pgTable, text, timestamp, uniqueIndex, uuid,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { operators } from './operators.js'
import { conversations } from './conversations.js'
import { followUpState } from './enums.js'

/**
 * Build plan step 31 — chasing a customer who went quiet.
 *
 * Section 11 of the MVP, in five lines: create a task for qualified or
 * unanswered enquiries, show overdue ones in the inbox, send only approved
 * automated follow-ups, stop automation after takeover, opt-out, complaint,
 * win or loss, and reopen a lead when the customer replies.
 *
 * "Only approved" is the one that shapes this table. The wording comes from the
 * operator's published follow-up policy, not from a model — a follow-up is an
 * unprompted message to someone who did not reply, which is the message most
 * likely to be reported as spam if it reads as machine-generated nagging.
 * Until that policy is published, a due follow-up raises a task and sends
 * nothing.
 *
 * There is no retry loop here and no backoff. A follow-up that fails is a
 * person's job, because the reason it failed — outside the 24-hour window, the
 * customer opted out, somebody took over — is never something a retry fixes.
 */
export const followUps = pgTable(
  'follow_ups',
  {
    id: uuid().primaryKey().defaultRandom(),
    operatorId: uuid()
      .notNull()
      .references(() => operators.id, { onDelete: 'cascade' }),
    conversationId: uuid().notNull(),

    /** Which chase this is. The operator's policy says how many are allowed. */
    attempt: integer().notNull().default(1),
    dueAt: timestamp({ withTimezone: true }).notNull(),

    state: followUpState().notNull().default('scheduled'),

    /** Why it was scheduled: 'awaiting_customer', 'qualified_no_reply'. */
    reason: text().notNull(),

    /** The message actually sent, kept so a chase can be read back later. */
    sentBody: text(),
    sentMessageId: uuid(),
    sentAt: timestamp({ withTimezone: true }),

    /** Why it stopped: 'customer_replied', 'opted_out', 'taken_over', 'won', 'lost'. */
    cancelledReason: text(),
    cancelledAt: timestamp({ withTimezone: true }),

    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.conversationId, table.operatorId],
      foreignColumns: [conversations.id, conversations.operatorId],
      name: 'follow_ups_conversation_operator_fkey',
    }),
    /**
     * One scheduled chase per conversation.
     *
     * Without this, a customer who sends three messages and goes quiet is
     * chased three times. The partial index makes that impossible rather than
     * unlikely.
     */
    uniqueIndex('follow_ups_one_scheduled_per_conversation')
      .on(table.conversationId)
      .where(sql`state = 'scheduled'`),
    index('follow_ups_due_idx').on(table.state, table.dueAt),
    index('follow_ups_conversation_idx').on(table.conversationId),
  ],
)

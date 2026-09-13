import { sql } from 'drizzle-orm'
import {
  foreignKey, index, pgTable, text, timestamp, unique, uniqueIndex, uuid,
} from 'drizzle-orm/pg-core'
import { conversations, messages } from './conversations.js'
import { enquiryField, salesStage, verificationState } from './enums.js'
import { operators } from './operators.js'

/**
 * A rental request. Separate from the conversation because section 18.6 notes
 * a customer can have several — a Lamborghini for the weekend and a chauffeur
 * car for the airport run are two enquiries in one thread.
 */
export const enquiries = pgTable(
  'enquiries',
  {
    id: uuid().primaryKey().defaultRandom(),
    operatorId: uuid().notNull().references(() => operators.id, { onDelete: 'cascade' }),
    conversationId: uuid().notNull(),
    stage: salesStage().notNull().default('new'),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.conversationId, table.operatorId],
      foreignColumns: [conversations.id, conversations.operatorId],
      name: 'enquiries_conversation_operator_fkey',
    }),
    unique('enquiries_id_operator_key').on(table.id, table.operatorId),
    index('enquiries_conversation_idx').on(table.conversationId),
  ],
)

/**
 * Build plan step 21 — every extracted fact, with its evidence.
 *
 * Section 7: `value + source message + extracted time + confidence +
 * verification state`. The source message matters most. When a salesperson
 * doubts a date, the answer to "where did that come from" has to be a specific
 * customer message, not "the model said so".
 *
 * Values are kept, never replaced. A correction supersedes rather than
 * overwrites, so the thread of what the customer said when stays intact.
 */
export const fieldEvidence = pgTable(
  'field_evidence',
  {
    id: uuid().primaryKey().defaultRandom(),
    operatorId: uuid().notNull().references(() => operators.id, { onDelete: 'cascade' }),
    enquiryId: uuid().notNull(),
    field: enquiryField().notNull(),

    /** The normalised value: an ISO date, a vehicle name, a number. */
    value: text().notNull(),

    /**
     * What the customer actually typed — "tomorrow", "this weekend", "sth
     * sporty under 1000". The MVP requires keeping it alongside the normalised
     * value, because the normalisation is a guess until confirmed and the
     * original is the only evidence of what was meant.
     */
    originalWording: text(),

    sourceMessageId: uuid(),
    extractedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    verificationState: verificationState().notNull().default('customer_stated'),

    /**
     * Set when a later statement replaced this one. The row stays: section 15
     * forbids silently overwriting, and a superseded value is what makes the
     * conflict explainable to the customer.
     */
    supersededAt: timestamp({ withTimezone: true }),
    supersededById: uuid(),

    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.enquiryId, table.operatorId],
      foreignColumns: [enquiries.id, enquiries.operatorId],
      name: 'field_evidence_enquiry_operator_fkey',
    }),
    foreignKey({
      columns: [table.sourceMessageId, table.operatorId],
      foreignColumns: [messages.id, messages.operatorId],
      name: 'field_evidence_message_operator_fkey',
    }),

    /**
     * One live value per field. Superseded rows are excluded, so history
     * accumulates without ever making "what is the start date" ambiguous.
     */
    uniqueIndex('field_evidence_one_live_per_field')
      .on(table.enquiryId, table.field)
      .where(sql`superseded_at is null`),

    index('field_evidence_enquiry_idx').on(table.enquiryId, table.field),
  ],
)

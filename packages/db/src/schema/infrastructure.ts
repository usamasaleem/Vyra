import { sql } from 'drizzle-orm'
import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { actorType, inboundEventStatus, outboxStatus } from './enums.js'
import { operators, whatsappAccounts } from './operators.js'

/**
 * Raw provider events, written before the webhook acknowledges.
 *
 * Section 18.4 step 2: persist the event, deduplicate it and add an outbox row
 * in one transaction, then return success. If storage fails we must not
 * acknowledge, because Meta treats an acknowledgement as "you have this now".
 */
export const inboundEvents = pgTable(
  'inbound_events',
  {
    id: uuid().primaryKey().defaultRandom(),

    /**
     * Resolved from the receiving `phone_number_id` before insert, never from
     * message content. Not null: an event we cannot attribute to an operator is
     * rejected at the edge rather than stored unattributed.
     */
    operatorId: uuid()
      .notNull()
      .references(() => operators.id, { onDelete: 'cascade' }),
    whatsappAccountId: uuid()
      .notNull()
      .references(() => whatsappAccounts.id, { onDelete: 'cascade' }),

    /** The provider's own identifier for this event — the deduplication key. */
    providerEventKey: text().notNull(),

    /** The untouched payload, kept for replay and for reconciling send outcomes. */
    payload: jsonb().notNull(),

    status: inboundEventStatus().notNull().default('received'),
    receivedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp({ withTimezone: true }),
    lastError: text(),
  },
  (table) => [
    /** A duplicate delivery collides here and is discarded, not processed twice. */
    uniqueIndex('inbound_events_account_event_key').on(
      table.whatsappAccountId,
      table.providerEventKey,
    ),
    index('inbound_events_status_idx').on(table.status, table.receivedAt),
    index('inbound_events_operator_idx').on(table.operatorId),
  ],
)

/**
 * The transactional outbox — the reason a lost queue does not mean a lost message.
 *
 * The dual-write problem: if the database write succeeds and the queue publish
 * fails, the message is gone. Writing the intent in the same transaction as the
 * event, then publishing afterwards, makes the queue recoverable from the
 * database. Publishing the same row twice must be harmless.
 *
 * This is build plan step 8, and everything after it inherits message loss if
 * it is skipped.
 */
export const outbox = pgTable(
  'outbox',
  {
    id: uuid().primaryKey().defaultRandom(),
    operatorId: uuid()
      .notNull()
      .references(() => operators.id, { onDelete: 'cascade' }),

    /** The job name, e.g. `process_inbound_message`, `dispatch_outbound`. */
    eventType: text().notNull(),
    /** The row this job is about — a message, conversation or handoff id. */
    aggregateId: uuid(),
    payload: jsonb().notNull(),

    status: outboxStatus().notNull().default('pending'),
    attempts: integer().notNull().default(0),
    nextAttemptAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    lastError: text(),

    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    publishedAt: timestamp({ withTimezone: true }),
  },
  (table) => [
    /** The relay's claim query: due, unpublished work, oldest first. */
    index('outbox_pending_idx')
      .on(table.nextAttemptAt)
      .where(sql`status = 'pending'`),
    /** Terminal failures a human has to see and retry. */
    index('outbox_dead_idx')
      .on(table.operatorId, table.createdAt)
      .where(sql`status = 'dead'`),
  ],
)

/**
 * Who did what, to which version of what, and when.
 *
 * Section 4 principle 8: record source, timestamp, actor, decision and status
 * for material claims and state changes. Ownership changes, quotes, handoffs
 * and customer-facing commitments all land here.
 */
export const auditEvents = pgTable(
  'audit_events',
  {
    id: uuid().primaryKey().defaultRandom(),
    operatorId: uuid()
      .notNull()
      .references(() => operators.id, { onDelete: 'cascade' }),

    actorType: actorType().notNull(),
    /** Membership id, agent run id, or null for the system. */
    actorId: uuid(),

    /** e.g. `conversation.takeover`, `message.sent`, `knowledge.published`. */
    action: text().notNull(),
    subjectType: text().notNull(),
    subjectId: uuid(),
    /** The exact version acted upon, so approval binds to one revision. */
    subjectVersion: integer(),

    /** Ties inbound event -> job -> agent run -> send intent -> provider result. */
    correlationId: uuid(),

    data: jsonb().$type<Record<string, unknown> | null>(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('audit_events_operator_created_idx').on(table.operatorId, table.createdAt),
    index('audit_events_subject_idx').on(table.subjectType, table.subjectId),
    index('audit_events_correlation_idx').on(table.correlationId),
  ],
)

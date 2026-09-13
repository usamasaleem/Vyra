import { sql } from 'drizzle-orm'
import {
  check,
  foreignKey,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { memberships, operators } from './operators.js'

/**
 * Where an answer came from.
 *
 * `placeholder` exists because development needs answers before the operator
 * has supplied them. It is not a lesser grade of approved content — it is
 * content that must never reach a customer, and the check constraint below
 * makes publishing it impossible rather than discouraged.
 */
export const knowledgeProvenance = pgEnum('knowledge_provenance', [
  'placeholder',
  'operator_confirmed',
])

/**
 * Build plan step 20 — approved knowledge, versioned, with an explicit publish
 * step so an answer can be traced to its source.
 *
 * Superseded versions are kept rather than overwritten. Section 3 of the
 * Operations MVP requires that an earlier quote can still be explained, and
 * the same applies here: when a customer says "you told me the deposit was
 * X", somebody needs to see what the approved answer was that day.
 */
export const knowledgeEntries = pgTable(
  'knowledge_entries',
  {
    id: uuid().primaryKey().defaultRandom(),
    operatorId: uuid()
      .notNull()
      .references(() => operators.id, { onDelete: 'cascade' }),

    /** Stable key for a subject: 'deposit', 'included-kilometres'. */
    topic: text().notNull(),
    /** The shape of question this answers, for retrieval and for review. */
    covers: text(),
    answer: text().notNull(),

    /** Increments per operator and topic. Version 1 is the first draft. */
    version: integer().notNull(),

    provenance: knowledgeProvenance().notNull().default('placeholder'),
    /** The person at the operator who confirmed this wording. */
    confirmedBy: text(),
    confirmedAt: timestamp({ withTimezone: true }),

    /** Null until published. Publishing is an explicit act, never a side effect. */
    publishedAt: timestamp({ withTimezone: true }),
    publishedByMembershipId: uuid(),

    /** The window this version was the approved answer. */
    effectiveFrom: timestamp({ withTimezone: true }),
    effectiveTo: timestamp({ withTimezone: true }),

    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.publishedByMembershipId, table.operatorId],
      foreignColumns: [memberships.id, memberships.operatorId],
      name: 'knowledge_entries_publisher_operator_fkey',
    }),

    uniqueIndex('knowledge_entries_operator_topic_version_key').on(
      table.operatorId,
      table.topic,
      table.version,
    ),

    /**
     * One current answer per topic. Two published versions with no end date
     * would make "what does the operator say about deposits" ambiguous, and
     * whichever the query happened to return would look authoritative.
     */
    uniqueIndex('knowledge_entries_one_current_per_topic')
      .on(table.operatorId, table.topic)
      .where(sql`published_at is not null and effective_to is null`),

    index('knowledge_entries_lookup_idx').on(table.operatorId, table.topic, table.effectiveFrom),

    /**
     * The guard that matters, enforced by the database rather than by the
     * code that happens to call it. Invented content cannot be published even
     * by a direct SQL mistake, a migration, or a future query that forgot.
     */
    check(
      'knowledge_published_requires_operator_confirmation',
      sql`published_at is null or (
        provenance = 'operator_confirmed'
        and confirmed_by is not null
        and confirmed_at is not null
        and effective_from is not null
      )`,
    ),
  ],
)

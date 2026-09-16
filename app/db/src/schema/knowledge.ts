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
    /**
     * The account that stood behind it, which is not the same as the name.
     *
     * `confirmedBy` is free text so an admin can record a colleague who made
     * the call — "Ahmed, operations" — and that is worth keeping. But free text
     * is also how nine invented answers came to be published to real customers:
     * the seed script wrote the sentence "DEMO DATA — not confirmed by an
     * operator" into this field, satisfied the check constraint below, and the
     * agent quoted the resulting deposit figure as the operator's policy.
     *
     * The constraint was not wrong. It asked for a name and got one. So a
     * published answer now needs an account as well, for the same reason
     * `vehicles` has had one since it was written: a foreign key cannot be
     * talked into existing.
     */
    confirmedByMembershipId: uuid(),
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
    foreignKey({
      columns: [table.confirmedByMembershipId, table.operatorId],
      foreignColumns: [memberships.id, memberships.operatorId],
      name: 'knowledge_entries_confirmer_operator_fkey',
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

    /**
     * The same guard, asking for something that cannot be written.
     *
     * The constraint above was satisfied by a seed script for four days while
     * the agent told customers an invented deposit, kilometre allowance and
     * licence rule as the operator's confirmed policy. Every field it asked for
     * was filled in. None of them could be wrong, because a string cannot be
     * wrong — it can only be untrue.
     *
     * Added NOT VALID on purpose. The fabricated rows are retired rather than
     * rewritten: attributing them to the real admin to satisfy a constraint
     * would be the same lie again, in the same field, for the same reason.
     */
    check(
      'knowledge_published_requires_a_real_person',
      sql`published_at is null or (
        confirmed_by_membership_id is not null
        and published_by_membership_id is not null
      )`,
    ),
  ],
)

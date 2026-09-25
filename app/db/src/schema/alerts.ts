import {
  check, foreignKey, index, integer, pgTable, smallint, text, timestamp, uniqueIndex, uuid,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { memberships, operators } from './operators.js'
import { boolean } from 'drizzle-orm/pg-core'

/**
 * Telling a person, on their phone, that a customer is waiting on them.
 *
 * Until this existed the only way to learn that the agent needed somebody was
 * to have the inbox open. Live: a AED 33,000 booking waited overnight for a
 * confirmation nobody knew was wanted, and "AI unavailable — reply manually"
 * sat on a conversation until somebody happened to look. Every other part of
 * the system escalates to a person; nothing reached one.
 *
 * Web push rather than WhatsApp. WhatsApp only lets the business message a
 * colleague inside 24 hours of the colleague's own last message, and outside
 * it needs a template Meta has approved, which this pilot does not have. A
 * phone notification from the inbox has no window and no approval.
 */

/** One phone or browser that asked to be told. */
export const pushSubscriptions = pgTable(
  'push_subscriptions',
  {
    id: uuid().primaryKey().defaultRandom(),
    operatorId: uuid()
      .notNull()
      .references(() => operators.id, { onDelete: 'cascade' }),
    membershipId: uuid().notNull(),
    /** Where the browser's push service accepts messages for this device. */
    endpoint: text().notNull(),
    p256dh: text().notNull(),
    auth: text().notNull(),
    /** So a person can tell their phone from their laptop in the list. */
    userAgent: text(),
    lastSentAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.membershipId, table.operatorId],
      foreignColumns: [memberships.id, memberships.operatorId],
      name: 'push_subscriptions_membership_operator_fkey',
    }).onDelete('cascade'),
    uniqueIndex('push_subscriptions_endpoint_key').on(table.endpoint),
    index('push_subscriptions_operator_idx').on(table.operatorId),
  ],
)

/**
 * Every alert, once.
 *
 * `subject` is what makes it once: a handoff alerts on its id and priority, so
 * the same handoff raised again is silent and the same handoff raised to
 * urgent is not. The sweep inserts with on-conflict-do-nothing and sends what
 * has not been sent, so a crash between the two sends late rather than twice.
 */
export const teamAlerts = pgTable(
  'team_alerts',
  {
    id: uuid().primaryKey().defaultRandom(),
    operatorId: uuid()
      .notNull()
      .references(() => operators.id, { onDelete: 'cascade' }),
    /** Null is everybody at the operator who asked to be told. */
    membershipId: uuid(),
    conversationId: uuid(),
    kind: text().notNull(),
    subject: text().notNull(),
    title: text().notNull(),
    body: text().notNull(),
    /** Path inside the inbox the notification opens. */
    url: text().notNull(),
    sentAt: timestamp({ withTimezone: true }),
    /** Devices it reached. Zero is recorded rather than hidden. */
    delivered: integer(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('team_alerts_subject_key').on(table.operatorId, table.kind, table.subject),
    index('team_alerts_unsent_idx').on(table.createdAt).where(sql`sent_at is null`),
  ],
)

/**
 * The key pair a push service checks the sender against. One row, ever.
 *
 * In the database rather than in each service's environment, because the
 * inbox (which subscribes phones) and the worker (which sends) must hold the
 * same pair, and a pair that drifted between them would fail silently on
 * every phone. The worker makes it on first start. The restricted role reads
 * the public half only.
 */
export const pushKeys = pgTable(
  'push_keys',
  {
    id: smallint().primaryKey().default(1),
    publicKey: text().notNull(),
    privateKey: text().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  () => [check('push_keys_single_row', sql`id = 1`)],
)

/**
 * The templates submitted to Meta for one operator, and what Meta said.
 *
 * Synced from Meta rather than assumed: a template is only used while its
 * status here is APPROVED, and a rejected or paused one quietly goes back to
 * being a task for a person.
 */
export const whatsappTemplates = pgTable(
  'whatsapp_templates',
  {
    id: uuid().primaryKey().defaultRandom(),
    operatorId: uuid()
      .notNull()
      .references(() => operators.id, { onDelete: 'cascade' }),
    name: text().notNull(),
    language: text().notNull(),
    category: text().notNull(),
    body: text().notNull(),
    /** PENDING, APPROVED, REJECTED, PAUSED, DISABLED — Meta's words, as Meta sends them. */
    status: text().notNull(),
    providerTemplateId: text(),
    rejectedReason: text(),
    submittedAt: timestamp({ withTimezone: true }),
    checkedAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('whatsapp_templates_name_key').on(table.operatorId, table.name, table.language),
  ],
)

/**
 * An operator's own payment account — Stripe — so payment links are made and
 * payments confirmed without anybody attaching or ticking anything.
 *
 * The secret key and the webhook signing secret are sealed, like a WhatsApp
 * token; what is shown is the last four characters and whether it is live.
 */
export const paymentAccounts = pgTable('payment_accounts', {
  operatorId: uuid().primaryKey().references(() => operators.id, { onDelete: 'cascade' }),
  provider: text().notNull(),
  secretKeyCipher: text().notNull(),
  secretKeyHint: text().notNull(),
  webhookSecretCipher: text().notNull(),
  webhookEndpointId: text().notNull(),
  accountId: text().notNull(),
  livemode: boolean().notNull(),
  connectedByMembershipId: uuid(),
  connectedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
})

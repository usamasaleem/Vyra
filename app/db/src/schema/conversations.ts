import { sql } from 'drizzle-orm'
import {
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import {
  bookingStatus,
  deliveryState,
  handlerMode,
  messageDirection,
  messageKind,
  priority,
  salesStage,
  waitingReason,
} from './enums.js'
import { memberships, operators, whatsappAccounts } from './operators.js'

/**
 * A person reachable on a channel.
 *
 * Deliberately not "customer": section 15 warns against merging returning
 * customers by name or preference. A WhatsApp number is a contact handle, not
 * a verified legal identity.
 */
export const contacts = pgTable(
  'contacts',
  {
    id: uuid().primaryKey().defaultRandom(),
    operatorId: uuid()
      .notNull()
      .references(() => operators.id, { onDelete: 'cascade' }),

    /** E.164 WhatsApp number. */
    channelIdentifier: text().notNull(),
    /** The WhatsApp profile name. Display only — never used to match identity. */
    displayName: text(),

    /** Set only once identity is reconciled through an approved process. */
    verifiedIdentityRef: text(),

    /** Opt-out stops automated follow-up immediately and permanently. */
    optedOutAt: timestamp({ withTimezone: true }),

    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('contacts_operator_channel_key').on(table.operatorId, table.channelIdentifier),
    unique('contacts_id_operator_key').on(table.id, table.operatorId),
  ],
)

/**
 * One thread with one contact.
 *
 * The four state fields below are independent on purpose. A lead can be
 * `qualified` + `human` + `waiting_for_operations` + `none` at the same time,
 * and a single flat status column cannot express that combination.
 */
export const conversations = pgTable(
  'conversations',
  {
    id: uuid().primaryKey().defaultRandom(),
    operatorId: uuid()
      .notNull()
      .references(() => operators.id, { onDelete: 'cascade' }),
    contactId: uuid().notNull(),
    whatsappAccountId: uuid().notNull(),

    // --- the four independent state fields ---
    salesStage: salesStage().notNull().default('new'),
    handlerMode: handlerMode().notNull().default('ai'),
    waitingReason: waitingReason().notNull().default('none'),
    bookingStatus: bookingStatus().notNull().default('none'),

    /** The membership that owns the next reply when handlerMode is `human`. */
    ownerMembershipId: uuid(),
    priority: priority().notNull().default('normal'),

    /**
     * Incremented by takeover, by a customer correction, and by any change that
     * invalidates work in flight.
     *
     * This is the concurrency primitive for the whole system. A model call runs
     * for seconds outside any transaction; a short transaction then compares
     * this number before accepting its output (build plan step 25). Without it,
     * takeover is a UI state rather than a guarantee.
     */
    revision: integer().notNull().default(0),

    /**
     * What happened earlier, in prose, for the messages that have fallen out of
     * the recent window.
     *
     * §18.8 asks for summarisation and its absence is a correctness bug, not a
     * refinement: the model is given the last twenty messages, so the
     * twenty-first silently erases the first. A customer who chats over three
     * days loses their own requirements, and the agent asks again for something
     * they already answered.
     *
     * Prose, and deliberately only the part that is not already structured.
     * Dates, vehicle and delivery live in field_evidence with the message that
     * proved them, which is better than a summary in every way — it is exact,
     * attributable and supersedable. What a summary adds is the rest: what they
     * care about, what they objected to, what they were already told.
     */
    summary: text(),
    /**
     * How many messages the summary covers, so it is regenerated when enough
     * new ones have fallen out of the window rather than on every turn.
     */
    summaryThroughCount: integer().notNull().default(0),

    /** Drives the 24-hour sending window, evaluated at dispatch — never earlier. */
    lastCustomerMessageAt: timestamp({ withTimezone: true }),
    lastStaffResponseAt: timestamp({ withTimezone: true }),
    firstResponseAt: timestamp({ withTimezone: true }),

    nextActionAt: timestamp({ withTimezone: true }),
    nextAction: text(),
    lostReason: text(),

    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    /**
     * Tenant-consistent foreign keys: a conversation cannot reference another
     * operator's contact, account or staff member. Section 18.6 requires this
     * shape so cross-tenant references are impossible rather than merely unlikely.
     */
    foreignKey({
      columns: [table.contactId, table.operatorId],
      foreignColumns: [contacts.id, contacts.operatorId],
      name: 'conversations_contact_operator_fkey',
    }),
    foreignKey({
      columns: [table.whatsappAccountId, table.operatorId],
      foreignColumns: [whatsappAccounts.id, whatsappAccounts.operatorId],
      name: 'conversations_account_operator_fkey',
    }),
    foreignKey({
      columns: [table.ownerMembershipId, table.operatorId],
      foreignColumns: [memberships.id, memberships.operatorId],
      name: 'conversations_owner_operator_fkey',
    }),
    unique('conversations_id_operator_key').on(table.id, table.operatorId),

    /**
     * One conversation per contact, per operator.
     *
     * The MVP requires reopening the existing conversation when a customer
     * replies later rather than starting a fresh thread. Without this
     * constraint, two messages arriving at once would race and create two
     * conversations for one person; with it, the second upsert reopens the
     * first. Multiple rental requests belong to `enquiries`, not here.
     */
    unique('conversations_operator_contact_key').on(table.operatorId, table.contactId),
    index('conversations_operator_stage_idx').on(table.operatorId, table.salesStage),
    index('conversations_operator_owner_idx').on(table.operatorId, table.ownerMembershipId),
    index('conversations_contact_idx').on(table.contactId),
  ],
)

/**
 * Every inbound and outbound message, durable across restarts.
 *
 * One table for both directions, because the inbox renders a single thread and
 * the dispatcher is the only writer of outbound rows — including for messages a
 * salesperson types by hand (section 18.3).
 */
export const messages = pgTable(
  'messages',
  {
    id: uuid().primaryKey().defaultRandom(),
    operatorId: uuid()
      .notNull()
      .references(() => operators.id, { onDelete: 'cascade' }),
    conversationId: uuid().notNull(),

    direction: messageDirection().notNull(),
    kind: messageKind().notNull(),

    /** Meta's message id (`wamid...`). Null until the provider accepts a send. */
    providerId: text(),

    /** Text body, or a human-readable placeholder for a non-text kind. */
    body: text(),
    /** Media pointer and provider metadata. Never the file itself. */
    media: jsonb().$type<Record<string, unknown> | null>(),

    /**
     * Reply buttons to send with an outbound message, as [{id, title}].
     *
     * Null for the overwhelming majority: a rental enquiry is a conversation,
     * and only two closed questions earn a tap. Stored on the message rather
     * than decided at send time so what the customer was offered is recoverable
     * afterwards — a tapped "Yes, correct" means nothing without the question
     * it answered.
     */
    replyButtons: jsonb().$type<Array<{ id: string; title: string }> | null>(),

    /**
     * A tappable list of options, for the one question buttons cannot hold:
     * which car.
     *
     * Separate from replyButtons rather than one polymorphic column, because a
     * message carries at most one of them and two typed columns say that more
     * plainly than one column with a discriminator inside it. Meta allows ten
     * rows; a fleet larger than that is described in prose instead, which is
     * what a salesperson would do anyway.
     */
    /**
     * A photograph to send with this reply, as a public HTTPS link.
     *
     * One image, with the reply as its caption, so a picture costs one message
     * rather than a burst of them. WhatsApp allows 1024 characters of caption,
     * which is longer than any reply this agent writes.
     */
    replyImageUrl: text(),

    replyList: jsonb().$type<{
      button: string
      rows: Array<{ id: string; title: string; description?: string }>
    } | null>(),

    /**
     * The earlier message this one quotes, shown in a contextual bubble above
     * it — Meta calls them contextual replies.
     *
     * Our id rather than Meta's, so it is a reference that survives and can be
     * read in the inbox. The wamid is looked up at the moment of sending,
     * which is the only place it is needed and the only place it is known to
     * still be valid.
     *
     * No foreign key, deliberately: a quote is a nicety, and a constraint that
     * can fail a send is a worse trade than a quote that silently does not
     * render.
     */
    quotesMessageId: uuid(),

    deliveryState: deliveryState().notNull().default('pending'),
    errorCode: text(),
    errorDetail: text(),

    /** Set when a salesperson wrote it; null for AI and customer messages. */
    sentByMembershipId: uuid(),

    /**
     * The logical send intent. Two attempts to send the same intent collapse to
     * one row — though this alone cannot resolve the network ambiguity in
     * section 18.10, where Meta may have accepted a send whose response was lost.
     */
    idempotencyKey: text(),

    /** The conversation revision this send was authorised against. */
    revisionAtSend: integer(),

    /** When the provider says it happened, which is not when we stored it. */
    providerTimestamp: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.conversationId, table.operatorId],
      foreignColumns: [conversations.id, conversations.operatorId],
      name: 'messages_conversation_operator_fkey',
    }),
    foreignKey({
      columns: [table.sentByMembershipId, table.operatorId],
      foreignColumns: [memberships.id, memberships.operatorId],
      name: 'messages_sender_operator_fkey',
    }),

    /**
     * Target for tenant-consistent composite foreign keys, matching the other
     * tables. field_evidence references a message this way so an extracted
     * fact cannot cite a message belonging to another operator.
     */
    unique('messages_id_operator_key').on(table.id, table.operatorId),

    /** A redelivered webhook cannot create a second message row. */
    uniqueIndex('messages_operator_provider_id_key')
      .on(table.operatorId, table.providerId)
      .where(sql`provider_id is not null`),

    /** One logical outbound intent sends at most once. */
    uniqueIndex('messages_operator_idempotency_key')
      .on(table.operatorId, table.idempotencyKey)
      .where(sql`idempotency_key is not null`),

    index('messages_conversation_created_idx').on(table.conversationId, table.createdAt),
  ],
)

/**
 * Internal notes. Never sent to a customer.
 *
 * A separate table rather than a flag on `messages`, deliberately. Section
 * 18.12 requires that internal notes never reach the outbound dispatcher, and
 * the dispatcher only ever reads `messages` — so a note cannot be sent by
 * mistake, a misread flag, or a future query that forgets to filter. The
 * safety property is structural instead of remembered.
 */
export const conversationNotes = pgTable(
  'conversation_notes',
  {
    id: uuid().primaryKey().defaultRandom(),
    operatorId: uuid()
      .notNull()
      .references(() => operators.id, { onDelete: 'cascade' }),
    conversationId: uuid().notNull(),
    /** Null once the author's membership is removed; the note itself stays. */
    authorMembershipId: uuid(),
    body: text().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.conversationId, table.operatorId],
      foreignColumns: [conversations.id, conversations.operatorId],
      name: 'conversation_notes_conversation_operator_fkey',
    }),
    foreignKey({
      columns: [table.authorMembershipId, table.operatorId],
      foreignColumns: [memberships.id, memberships.operatorId],
      name: 'conversation_notes_author_operator_fkey',
    }),
    index('conversation_notes_conversation_idx').on(table.conversationId, table.createdAt),
  ],
)

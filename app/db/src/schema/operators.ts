import { sql } from 'drizzle-orm'
import {
  boolean,
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
import { membershipRole } from './enums.js'

/** A rental business. The tenant boundary for everything else in this schema. */
export const operators = pgTable('operators', {
  id: uuid().primaryKey().defaultRandom(),
  name: text().notNull(),

  /**
   * IANA zone, used to interpret "tomorrow" and "this weekend" against the
   * time a message was sent. Stored timestamps stay UTC.
   */
  timezone: text().notNull().default('Asia/Dubai'),

  /** Opening hours, for honest out-of-hours replies rather than invented ones. */
  serviceHours: jsonb().$type<ServiceHours | null>(),

  /** What the operator tells customers to expect. Never an invented callback time. */
  responseExpectation: text(),

  policyVersion: integer().notNull().default(1),

  /**
   * Per-operator AI kill switch. False until that operator's shadow-mode
   * drafts have been reviewed. The env-level switch stops every operator at once.
   */
  aiSendingEnabled: boolean().notNull().default(false),

  /**
   * How long a handoff may sit unaccepted before the fallback owner is told.
   *
   * The operator's number, not ours. What counts as slow for a Rolls-Royce
   * enquiry at 2am is their judgement about their own business.
   */
  handoffSlaMinutes: integer().notNull().default(30),

  /**
   * How long a customer may wait on a silent salesperson before the agent
   * answers them again. Null switches it off entirely.
   *
   * The pilot found the case this exists for: a customer asked about a
   * discount, was told a person would come back, and heard nothing for
   * thirty-five hours. Nothing in the system would ever have spoken to them
   * again — a conversation in human hands schedules no follow-up, because
   * follow-ups are scheduled by the turn that never runs.
   *
   * It returns the ability to reply, not the authority to decide. The handoff
   * stays open, the discount still needs a manager, and the agent is held to
   * the same tool boundary as always. What changes is that the customer stops
   * being ignored.
   *
   * An hour by default. Long enough that a salesperson writing a considered
   * reply is not interrupted, short enough that nobody sits overnight in
   * silence.
   */
  aiResumesAfterMinutes: integer().default(60),

  /**
   * Who hears about a handoff nobody accepted.
   *
   * Nullable, and the escalation says so rather than failing silently: an
   * operator who has not named a fallback should find out from a visible
   * warning, not from a customer who waited all night. Set as a plain uuid —
   * a foreign key back to memberships would be circular at table-creation time.
   */
  fallbackOwnerMembershipId: uuid(),

  /**
   * How long an Operations answer stays usable before it must be rechecked.
   *
   * Section 6: "An expired answer is rechecked before it is reused."
   * Availability at 9am says nothing about 4pm, and four hours is a starting
   * point the operator should change once they know their own churn.
   */
  answerValidMinutes: integer().notNull().default(240),

    /**
     * Whether an empty calendar means the car is free.
     *
     * False by default, and that default is the point. A calendar with no block
     * against a car says nobody recorded a booking — which is a statement about
     * the calendar, not about the car. Treating it as "available" is how an
     * agent promises a vehicle that is already out.
     *
     * An operator turns this on when they actually keep the calendar current,
     * and it is their claim rather than our inference. Until then a block still
     * answers "no" with authority, and everything else still goes to a person.
     */
    availabilityCalendarComplete: boolean().notNull().default(false),

  /**
   * How long to wait before chasing a customer who has gone quiet.
   *
   * Separate from the follow-up *wording*, which comes from the published
   * `follow-up-timing` policy. Timing is a setting and being slightly off is
   * harmless; wording is an unprompted message with the operator's name on it,
   * and being off there is how a number gets reported. Four hours is a
   * placeholder until the operator answers.
   */
  followUpAfterMinutes: integer().notNull().default(240),

  /** Retention window for conversations, contacts and uploads. */
  retentionDays: integer().notNull().default(730),

  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
})

export type ServiceHours = {
  /** 0 = Sunday. Absent day means closed. */
  [dayOfWeek: string]: { open: string; close: string } | undefined
}

/**
 * The trusted channel routing table.
 *
 * Section 18.4: resolve the operator from the receiving phone number id, never
 * from text inside the message. A customer can write anything; the number that
 * received the webhook is the only trustworthy routing key.
 */
export const whatsappAccounts = pgTable(
  'whatsapp_accounts',
  {
    id: uuid().primaryKey().defaultRandom(),
    operatorId: uuid()
      .notNull()
      .references(() => operators.id, { onDelete: 'restrict' }),

    /** WhatsApp Business Account id. */
    providerAccountId: text().notNull(),
    /** The receiving number's id. This is the routing key from the webhook. */
    phoneNumberId: text().notNull(),
    displayPhoneNumber: text(),

    /**
     * A pointer into secret storage — never the access token itself.
     * Section 18.5: secrets stay in server-side secret storage.
     */
    secretRef: text(),

    active: boolean().notNull().default(true),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    /** One receiving number belongs to exactly one operator, globally. */
    uniqueIndex('whatsapp_accounts_phone_number_id_key').on(table.phoneNumberId),
    /** Target for tenant-consistent composite foreign keys. */
    unique('whatsapp_accounts_id_operator_key').on(table.id, table.operatorId),
    index('whatsapp_accounts_operator_idx').on(table.operatorId),
  ],
)

/**
 * Staff access. Authentication alone does not establish tenant authorization —
 * section 18.7. A browser-supplied operator id is a requested scope, and this
 * table is what decides whether the scope is granted.
 *
 * `userId` refers to Supabase `auth.users`. The foreign key is added in the
 * migration that wires Supabase Auth (build plan step 13), because the auth
 * schema is not managed by this package.
 */
/**
 * Somebody an admin has asked to join, who has not signed up yet.
 *
 * The alternative is Supabase's admin invite API, which needs the service-role
 * key — a credential that can read and write every row for every operator,
 * held by the web application, to send an email. That is a large thing to
 * carry for a small feature.
 *
 * So an invitation is a row, and signing up with an invited address joins that
 * operator at the role the admin chose. The admin sends the link themselves,
 * which they were going to do anyway.
 *
 * The email is stored lower-cased. Addresses are matched case-insensitively
 * everywhere a person types one, and normalising on the way in is the only
 * version of that which cannot be forgotten at a call site.
 */
export const operatorInvitations = pgTable(
  'operator_invitations',
  {
    id: uuid().primaryKey().defaultRandom(),
    operatorId: uuid()
      .notNull()
      .references(() => operators.id, { onDelete: 'cascade' }),
    email: text().notNull(),
    role: membershipRole().notNull(),
    /** Who asked. Null when the invitation outlived the person who sent it. */
    invitedByMembershipId: uuid(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    acceptedAt: timestamp({ withTimezone: true }),
    acceptedUserId: uuid(),
    revokedAt: timestamp({ withTimezone: true }),
  },
  (table) => [
    /**
     * One live invitation per address per operator. Inviting the same person
     * twice is a mistake to absorb, not an error to show — the second invite
     * updates the first rather than creating a duplicate somebody else has to
     * reconcile later.
     */
    uniqueIndex('operator_invitations_live_key')
      .on(table.operatorId, table.email)
      .where(sql`accepted_at is null and revoked_at is null`),
    index('operator_invitations_email_idx').on(table.email),
  ],
)

export const memberships = pgTable(
  'memberships',
  {
    id: uuid().primaryKey().defaultRandom(),
    operatorId: uuid()
      .notNull()
      .references(() => operators.id, { onDelete: 'cascade' }),
    userId: uuid().notNull(),
    role: membershipRole().notNull(),
    active: boolean().notNull().default(true),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('memberships_operator_user_key').on(table.operatorId, table.userId),
    /** Target for tenant-consistent composite foreign keys. */
    unique('memberships_id_operator_key').on(table.id, table.operatorId),
    index('memberships_user_idx').on(table.userId),
    index('memberships_operator_active_idx')
      .on(table.operatorId)
      .where(sql`active`),
  ],
)

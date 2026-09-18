import {
  foreignKey, index, integer, jsonb, pgTable, text, timestamp, unique, uniqueIndex, uuid,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { operators, memberships } from './operators.js'
import { conversations } from './conversations.js'
import { enquiries } from './enquiries.js'
import { vehicles } from './fleet.js'
import { bookingState, fleetProvenance, quoteState } from './enums.js'

/**
 * What a car costs, per the operator.
 *
 * Money is stored in the smallest currency unit — fils for AED — as integers.
 * Floating point and money do not belong in the same table: 0.1 + 0.2 is not
 * 0.3, and a rounding error in a rental total is a number the operator has to
 * explain to a customer.
 *
 * `provenance` guards this the way it guards the fleet and the knowledge base,
 * and here it matters most. A plausible invented deposit is the single failure
 * this entire system was built to prevent, so a rate nobody has confirmed
 * cannot be used in a calculation at all.
 */
export const vehicleRates = pgTable(
  'vehicle_rates',
  {
    id: uuid().primaryKey().defaultRandom(),
    operatorId: uuid()
      .notNull()
      .references(() => operators.id, { onDelete: 'cascade' }),
    vehicleId: uuid().notNull(),

    currency: text().notNull().default('AED'),

    /** Per rental day, in fils. 1,500.00 AED is 150000. */
    dailyRateMinor: integer().notNull(),
    /** Applied from this many days; null when there is no weekly rate. */
    weeklyRateMinor: integer(),
    monthlyRateMinor: integer(),

    minimumDays: integer().notNull().default(1),

    /** Kilometres included per rental day. */
    includedKmPerDay: integer(),
    /** Charge per kilometre beyond the allowance, in fils. */
    extraKmRateMinor: integer(),

    /** Refundable security deposit, in fils. */
    depositMinor: integer(),

    /** Delivery within the operator's free zone; null when it is not free. */
    deliveryFeeMinor: integer(),

    /**
     * The window this rate applied. Null `effectiveTo` means current.
     *
     * Rates are superseded rather than edited, for the same reason knowledge
     * answers are: when a customer quotes a price back three weeks later, the
     * question is what the rate was that day, and an edited row cannot answer
     * it.
     */
    effectiveFrom: timestamp({ withTimezone: true }).notNull().defaultNow(),
    effectiveTo: timestamp({ withTimezone: true }),

    provenance: fleetProvenance().notNull().default('placeholder'),
    confirmedBy: text(),
    confirmedAt: timestamp({ withTimezone: true }),

    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.vehicleId, table.operatorId],
      foreignColumns: [vehicles.id, vehicles.operatorId],
      name: 'vehicle_rates_vehicle_operator_fkey',
    }),
    index('vehicle_rates_vehicle_current_idx').on(table.vehicleId, table.effectiveTo),
    unique('vehicle_rates_id_operator_key').on(table.id, table.operatorId),
  ],
)

/**
 * A calculated draft, and the record of what was promised.
 *
 * Section 18.9: Sales may *request* a draft quote; Operations owns the
 * calculation, and Sales cannot turn an estimate into a booking. So a quote is
 * created in `draft` and a person moves it to `approved`. Nothing reaches a
 * customer in between — and the agent is never told the figures of an
 * unapproved quote, because a model cannot leak a number it does not have.
 *
 * Immutable per revision. A changed price is a new revision, never an edit:
 * "you quoted me 4,500" is a question about a specific version, and a row
 * edited in place has thrown the answer away.
 *
 * Lines live in jsonb rather than their own table. They are only ever written
 * with their revision and only ever read alongside it, so a separate table
 * would add a join and a way for the two to disagree.
 */
export const quotes = pgTable(
  'quotes',
  {
    id: uuid().primaryKey().defaultRandom(),
    operatorId: uuid()
      .notNull()
      .references(() => operators.id, { onDelete: 'cascade' }),
    conversationId: uuid().notNull(),
    enquiryId: uuid(),
    vehicleId: uuid(),

    /** Increments per enquiry. Revision 1 is the first draft. */
    revision: integer().notNull(),
    state: quoteState().notNull().default('draft'),

    currency: text().notNull().default('AED'),
    /** What the customer pays, in fils, excluding the refundable deposit. */
    totalMinor: integer().notNull(),
    depositMinor: integer(),

    /** `[{ label, amountMinor, detail }]`, in the order a customer reads them. */
    lines: jsonb().$type<Array<Record<string, unknown>>>().notNull(),

    startDate: timestamp({ withTimezone: true }),
    endDate: timestamp({ withTimezone: true }),
    days: integer(),

    /** The rate row used, so the calculation is reproducible later. */
    rateId: uuid(),

    /** After this the price is not honoured and the quote must be redone. */
    validUntil: timestamp({ withTimezone: true }),

    approvedByMembershipId: uuid(),
    approvedAt: timestamp({ withTimezone: true }),
    sentMessageId: uuid(),

    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.conversationId, table.operatorId],
      foreignColumns: [conversations.id, conversations.operatorId],
      name: 'quotes_conversation_operator_fkey',
    }),
    foreignKey({
      columns: [table.enquiryId, table.operatorId],
      foreignColumns: [enquiries.id, enquiries.operatorId],
      name: 'quotes_enquiry_operator_fkey',
    }),
    foreignKey({
      columns: [table.approvedByMembershipId, table.operatorId],
      foreignColumns: [memberships.id, memberships.operatorId],
      name: 'quotes_approver_operator_fkey',
    }),
    unique('quotes_id_operator_key').on(table.id, table.operatorId),
    index('quotes_operator_state_idx').on(table.operatorId, table.state, table.createdAt),
    index('quotes_conversation_idx').on(table.conversationId, table.revision),
  ],
)

/**
 * A customer said yes, and a person has to answer them.
 *
 * The funnel ended here and produced nothing. `request_booking_review` refused
 * every call — "booking review is not connected yet" — so the most a customer
 * saying "yes, book it" could achieve was a handoff, and `booking_status` sat
 * at 'none' on every conversation in the database while three quotes had been
 * sent. A system that can sell up to the moment of commitment and not record
 * the commitment is a system that loses exactly the conversations it won.
 *
 * A booking is a quote somebody said yes to. Everything that makes it a
 * rental — the car, the dates, the days, the total, the deposit, the rate it
 * was worked out from — is already on the quote and is not copied here, so
 * there is one set of figures and no second one to drift from it.
 *
 * What this is not is a confirmation. It records that a person was asked, and
 * carries who answered and when. Until somebody does, it is a request.
 */
export const bookings = pgTable(
  'bookings',
  {
    id: uuid().primaryKey().defaultRandom(),
    operatorId: uuid()
      .notNull()
      .references(() => operators.id, { onDelete: 'cascade' }),
    conversationId: uuid().notNull(),
    enquiryId: uuid(),
    /** The figures the customer agreed to. Never re-derived, never copied. */
    quoteId: uuid().notNull(),

    state: bookingState().notNull().default('requested'),

    /** The customer message that was their yes, so the agreement is evidenced. */
    requestedFromMessageId: uuid(),
    requestedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),

    /** Who answered them. Null while it is still a request. */
    decidedByMembershipId: uuid(),
    decidedAt: timestamp({ withTimezone: true }),
    /** Why, when the answer was no. For the person, not for the customer. */
    decisionNote: text(),

    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.conversationId, table.operatorId],
      foreignColumns: [conversations.id, conversations.operatorId],
      name: 'bookings_conversation_operator_fkey',
    }),
    foreignKey({
      columns: [table.quoteId, table.operatorId],
      foreignColumns: [quotes.id, quotes.operatorId],
      name: 'bookings_quote_operator_fkey',
    }),
    foreignKey({
      columns: [table.enquiryId, table.operatorId],
      foreignColumns: [enquiries.id, enquiries.operatorId],
      name: 'bookings_enquiry_operator_fkey',
    }),
    foreignKey({
      columns: [table.decidedByMembershipId, table.operatorId],
      foreignColumns: [memberships.id, memberships.operatorId],
      name: 'bookings_decider_operator_fkey',
    }),
    /**
     * One live request per quote.
     *
     * A customer says yes twice — "yes", then "yes?" ten minutes later when
     * nobody has replied — and that is one booking to answer, not two rows for
     * two people to answer separately. A declined or cancelled one leaves the
     * way clear for them to change their mind.
     */
    uniqueIndex('bookings_live_quote_key')
      .on(table.quoteId)
      .where(sql`state in ('requested', 'confirmed')`),
    index('bookings_operator_state_idx').on(table.operatorId, table.state, table.requestedAt),
    index('bookings_conversation_idx').on(table.conversationId),
  ],
)

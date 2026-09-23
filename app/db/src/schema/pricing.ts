import {
  boolean,  foreignKey, index, integer, jsonb, pgTable, text, timestamp, unique, uniqueIndex, uuid,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { operators, memberships } from './operators.js'
import { conversations } from './conversations.js'
import { enquiries } from './enquiries.js'
import { vehicles } from './fleet.js'
import {
  bookingState, fleetProvenance, paymentKind, paymentMethod, paymentState, quoteState,
} from './enums.js'

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

    /**
     * What a person took off the calculated price, in minor units.
     *
     * Null on an ordinary quote, which is nearly all of them. There was no way
     * to do this at all: calculateDraftQuote has no discount input by design —
     * "a discount is a manager's approval, not a calculation" — and approving
     * sends the exact figures. So a salesperson who wanted to take five
     * hundred off had to type it into a message, and then the record said one
     * thing while the customer had been told another. That was survivable
     * while a quote was only a number in a chat. It stopped being survivable
     * when bookings started confirming against a quote id: the customer agrees
     * to 9,500 and the booking holds them to 10,000.
     *
     * So a discount is a new revision of the quote with somebody's name on it,
     * which is what "a manager's approval" means once it has to be recorded
     * rather than remembered. A column rather than a line in `lines`, because
     * an operator will want to ask how much was given away last month and a
     * jsonb array is a poor thing to ask that of.
     */
    discountMinor: integer(),
    /** Why it was given. For the operator's own reckoning, never sent. */
    discountReason: text(),

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

    /**
     * True when the agent confirmed this itself, with nobody asked.
     *
     * Recorded rather than inferred from a null membership, because null
     * already means several things here — a request nobody has answered, a
     * decision by somebody since removed. A booking that committed a car with
     * no person in the loop is worth being able to find, count and argue with
     * afterwards.
     */
    decidedAutomatically: boolean().notNull().default(false),

    /**
     * Where and when the car goes, which nothing asked for.
     *
     * The enquiry records "delivery" and an area — "Dubai Marina" — and that
     * was where the agent stopped. A driver cannot deliver to an area, and
     * nobody had the time at all, so every confirmed booking needed a
     * salesperson to message the customer again before the car could move.
     * Collected by the agent after confirming, one question at a time.
     */
    deliveryAddress: text(),
    /** 24-hour HH:MM on the first day of the rental. */
    deliveryTime: text(),

    /**
     * How they have said they will pay, from the three the operator accepts.
     *
     * A plan rather than a payment: "I'll pay the driver" is an answer the
     * agent can record, and the money itself is still marked taken by a person
     * on the payment rows, who is the one who can see the account.
     */
    paymentPlan: text(),
    /**
     * When the customer said they had paid — a transfer screenshot, "done".
     *
     * Deliberately not the payment being taken. A screenshot is a claim, and
     * the salesperson checks the account before the car leaves; this is what
     * tells them there is something to check.
     */
    customerReportedPaidAt: timestamp({ withTimezone: true }),

    /** Who looked at the licence and passport photos, and when. */
    documentsCheckedAt: timestamp({ withTimezone: true }),
    documentsCheckedByMembershipId: uuid(),

    /**
     * The other end of the rental, collected by the agent the way the start
     * was: when the car comes back, and — for a delivered car — where it is
     * picked up from. 24-hour HH:MM on the last day.
     */
    returnTime: text(),
    returnAddress: text(),
    /** A person saw the car back. Their name goes on it, as with the documents. */
    returnedAt: timestamp({ withTimezone: true }),
    returnedByMembershipId: uuid(),

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
    /**
     * Target for tenant-consistent composite foreign keys, the same one every
     * other table here carries. Without it a child row can name a booking and
     * an operator that do not belong together, which is the whole reason these
     * keys are on the pair rather than the id.
     */
    unique('bookings_id_operator_key').on(table.id, table.operatorId),
    index('bookings_operator_state_idx').on(table.operatorId, table.state, table.requestedAt),
    index('bookings_conversation_idx').on(table.conversationId),
  ],
)

/**
 * What the customer owes, taken or not.
 *
 * `bookings` had no payment state at all: a car could be confirmed, held and
 * handed over with nothing anywhere recording whether a dirham had moved. The
 * deposit was the sharper half of that — it flows from the rate into the quote
 * and onto the screen, is quoted to customers, and has never been taken or
 * given back by anything.
 *
 * One row per thing owed, rather than a column on the booking, because a
 * rental and its deposit have separate lives: the rental is earned on the day
 * and the deposit is held and returned a week later, often by a different
 * person. Two states on one row cannot say that.
 *
 * No provider is wired. `providerRef` and `linkUrl` are here because the shape
 * of this table decides how hard that is later, and because an operator can
 * paste a link from whatever they already use today and have it work. What is
 * built now is the record and the human path — which is what a Dubai luxury
 * rental runs on anyway, where the deposit usually arrives as a bank transfer.
 */
export const payments = pgTable(
  'payments',
  {
    id: uuid().primaryKey().defaultRandom(),
    operatorId: uuid()
      .notNull()
      .references(() => operators.id, { onDelete: 'cascade' }),
    bookingId: uuid().notNull(),
    conversationId: uuid().notNull(),

    kind: paymentKind().notNull(),
    state: paymentState().notNull().default('due'),

    /** Integer minor units, like every other amount here. */
    amountMinor: integer().notNull(),
    currency: text().notNull().default('AED'),

    /** Null until it is taken. A due payment has no method yet. */
    method: paymentMethod(),
    /** Whatever the operator already uses. Null when nothing was sent. */
    linkUrl: text(),
    /** The provider's own id, for the day one is wired. */
    provider: text(),
    providerRef: text(),

    /** Who recorded it, when a person did rather than a webhook. */
    recordedByMembershipId: uuid(),
    /** Their own reference — a transfer number, a receipt. Never sent. */
    reference: text(),

    paidAt: timestamp({ withTimezone: true }),
    refundedAt: timestamp({ withTimezone: true }),

    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.bookingId, table.operatorId],
      foreignColumns: [bookings.id, bookings.operatorId],
      name: 'payments_booking_operator_fkey',
    }),
    foreignKey({
      columns: [table.conversationId, table.operatorId],
      foreignColumns: [conversations.id, conversations.operatorId],
      name: 'payments_conversation_operator_fkey',
    }),
    foreignKey({
      columns: [table.recordedByMembershipId, table.operatorId],
      foreignColumns: [memberships.id, memberships.operatorId],
      name: 'payments_recorder_operator_fkey',
    }),
    /**
     * One live row per booking per kind. Confirming twice, or a sweep running
     * twice, must not ask a customer for the same deposit two ways.
     */
    uniqueIndex('payments_live_kind_key')
      .on(table.bookingId, table.kind)
      .where(sql`state in ('due', 'paid')`),
    index('payments_operator_state_idx').on(table.operatorId, table.state, table.createdAt),
  ],
)

/**
 * A photo the customer sent for their booking — a licence, a passport.
 *
 * The agent cannot see images and never judges one. It files each photo
 * against the booking the customer has and tells them it has been received;
 * a person looks at them before the car leaves. The file stays where it
 * arrived, on the message, so this row is a pointer rather than a second copy
 * of somebody's identity document.
 *
 * Before this, every photo a customer sent became a handoff: "I can't view
 * images, so a colleague will take a look." Correct for a photo of a scratch,
 * and a dead end for the licence the agent had just asked them for.
 */
export const bookingDocuments = pgTable(
  'booking_documents',
  {
    id: uuid().primaryKey().defaultRandom(),
    operatorId: uuid()
      .notNull()
      .references(() => operators.id, { onDelete: 'cascade' }),
    bookingId: uuid().notNull(),
    conversationId: uuid().notNull(),
    /** The inbound message carrying the image. The media lives there. */
    messageId: uuid().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.bookingId, table.operatorId],
      foreignColumns: [bookings.id, bookings.operatorId],
      name: 'booking_documents_booking_operator_fkey',
    }),
    foreignKey({
      columns: [table.conversationId, table.operatorId],
      foreignColumns: [conversations.id, conversations.operatorId],
      name: 'booking_documents_conversation_operator_fkey',
    }),
    /** One photo is one document, however many times the job runs. */
    uniqueIndex('booking_documents_message_key').on(table.messageId),
    index('booking_documents_booking_idx').on(table.bookingId),
  ],
)

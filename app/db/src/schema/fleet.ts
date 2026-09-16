import {
  boolean, foreignKey, index, integer, jsonb, pgTable, text, timestamp, unique, uuid,
} from 'drizzle-orm/pg-core'
import { operators } from './operators.js'
import { memberships } from './operators.js'
import { vehicleCategory, fleetProvenance } from './enums.js'

/**
 * The operator's fleet — section 18.6's `vehicles` table.
 *
 * Two kinds of fact live near each other here and must not be confused.
 *
 * A **fleet fact** is that this car exists and has these specifications. It
 * changes when a car is bought or sold, which is rarely, and a salesperson can
 * confirm it from memory.
 *
 * An **availability fact** is that the car is free on a given date. It changes
 * constantly, and section 9 requires any answer about it to carry who checked
 * and when. That is why availability is not a column on this table: a boolean
 * here would be stale within the hour and would read, to every later caller,
 * exactly as authoritative as the chassis number.
 *
 * `provenance` is the same guard the knowledge table uses. Placeholder rows
 * exist so the agent can be built and demonstrated before an operator has
 * entered their real fleet, and they are shaped like real cars precisely so the
 * system is exercised realistically — which is what makes them dangerous. A
 * plausible invented Ferrari is harder to spot than an obviously wrong one.
 */
export const vehicles = pgTable(
  'vehicles',
  {
    id: uuid().primaryKey().defaultRandom(),
    operatorId: uuid()
      .notNull()
      .references(() => operators.id, { onDelete: 'cascade' }),

    // --- what the customer asks about ---
    make: text().notNull(),
    model: text().notNull(),
    /** Trim or variant: 'Spider', 'Performante', 'Long Wheelbase'. */
    variant: text(),
    year: integer().notNull(),
    colour: text().notNull(),
    category: vehicleCategory().notNull(),

    // --- what operations and the police care about ---
    /** UAE plate as written, e.g. 'Dubai A 12345'. */
    plate: text().notNull(),
    /** VIN / chassis number. 17 characters on any modern car. */
    chassisNumber: text().notNull(),

    // --- specification ---
    engine: text(),
    powerHp: integer(),
    transmission: text(),
    drivetrain: text(),
    seats: integer(),
    doors: integer(),
    /** Odometer at last check, in kilometres. */
    /**
   * Photographs of this exact car, as public HTTPS links.
   *
   * Links rather than stored files, because WhatsApp fetches the image itself
   * and every operator already has photographs of their own cars on their own
   * website. An upload screen can come later and will write a URL here, so
   * nothing about this changes when it does.
   *
   * Of this exact car, not the model. A customer renting a specific Huracán is
   * shown that Huracán, and a stock photograph of a different one is the same
   * class of untruth as a made-up price.
   */
  photoUrls: jsonb().$type<string[] | null>(),

  /**
   * One image containing several of the photographs, laid out in a grid.
   *
   * WhatsApp has no album for an API message — the grid a customer sees when a
   * person sends four pictures from the picker is the client grouping them, and
   * no integration can produce it. A composite is the honest way to get one
   * block: it is a single message, it renders identically everywhere, and it is
   * what most dealers send anyway.
   *
   * Stored rather than derived so the worker needs no knowledge of where the
   * inbox is published. The trade is that it goes stale if the domain changes,
   * which is a rename away from being fixed and a configuration step away from
   * being a permanent tax.
   */
  collageUrl: text(),

    odometerKm: integer(),

    /**
     * Whether the car is in the rentable fleet at all — sold, written off, or
     * off the road for a month is different from booked next Tuesday.
     */
    active: boolean().notNull().default(true),
    /** Why it is not rentable, when active is false. */
    inactiveReason: text(),

    /**
     * `placeholder` until someone at the operator confirms this is their car.
     * `search_vehicles` returns confirmed rows only, so invented specifications
     * cannot reach a customer by accident.
     */
    /**
     * A few words the operator wants beside this car — "Best seller", "Newest
     * arrival", "Only one in Dubai".
     *
     * Set by a person rather than computed, and that is the whole point.
     * "Best seller" is a factual claim about the business, and the honest
     * alternative is counting bookings — which early on means "the one we
     * photographed" and puts a number we invented into the operator's voice.
     * Every other claim this agent states carries somebody's name; so does
     * this.
     *
     * Short because the only place it fits is the 72 characters of a WhatsApp
     * list row's description, which the colour, engine and rate already use
     * fifty of. The surface that has real tags is Flows, and Meta will not let
     * this business use those.
     */
    highlight: text(),

    provenance: fleetProvenance().notNull().default('placeholder'),
    confirmedBy: text(),
    confirmedAt: timestamp({ withTimezone: true }),
    confirmedByMembershipId: uuid(),

    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.confirmedByMembershipId, table.operatorId],
      foreignColumns: [memberships.id, memberships.operatorId],
      name: 'vehicles_confirmed_by_operator_fkey',
    }),
    /** A plate is unique within an operator's fleet; two operators may both rent in Dubai. */
    unique('vehicles_operator_plate_key').on(table.operatorId, table.plate),
    unique('vehicles_operator_chassis_key').on(table.operatorId, table.chassisNumber),
    /** Target for tenant-consistent composite foreign keys. */
    unique('vehicles_id_operator_key').on(table.id, table.operatorId),
    index('vehicles_operator_active_idx').on(table.operatorId, table.active),
    index('vehicles_operator_make_model_idx').on(table.operatorId, table.make, table.model),
  ],
)


/**
 * When a car is not available, and why.
 *
 * The reactive half of availability already existed: the agent raises a
 * question, a person answers it, and the answer is good for a window. That
 * works and it costs a person every time.
 *
 * This is the other half. A salesperson records a booking once and every
 * enquiry touching those dates is answered without anyone being asked again.
 *
 * Blocks rather than a free/busy calendar, because what an operator actually
 * knows is when a car is taken. Absence of a block is absence of information,
 * not a statement that the car is free — see availabilityCalendarComplete on
 * the operator, which is where that claim is made deliberately by a person
 * rather than inferred from an empty table.
 */
export const vehicleAvailability = pgTable(
  'vehicle_availability',
  {
    id: uuid().primaryKey().defaultRandom(),
    operatorId: uuid()
      .notNull()
      .references(() => operators.id, { onDelete: 'cascade' }),
    vehicleId: uuid().notNull(),

    /** Inclusive. A car booked the 20th to the 23rd is out on both. */
    startDate: text().notNull(),
    endDate: text().notNull(),

    /** 'booked', 'maintenance', 'held', 'other'. */
    reason: text().notNull().default('booked'),
    note: text(),

    /** Who recorded it. A block that stops a sale needs a name against it. */
    recordedBy: text().notNull(),
    recordedByMembershipId: uuid(),

    /**
     * Cleared rather than deleted, so a cancelled booking that cost an enquiry
     * can still be explained afterwards.
     */
    releasedAt: timestamp({ withTimezone: true }),
    releasedBy: text(),

    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.vehicleId, table.operatorId],
      foreignColumns: [vehicles.id, vehicles.operatorId],
      name: 'vehicle_availability_vehicle_operator_fkey',
    }),
    index('vehicle_availability_lookup_idx')
      .on(table.operatorId, table.vehicleId, table.startDate, table.endDate),
  ],
)

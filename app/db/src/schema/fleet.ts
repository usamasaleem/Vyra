import {
  boolean, foreignKey, index, integer, pgTable, text, timestamp, unique, uuid,
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

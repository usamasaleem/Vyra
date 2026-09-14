import {
  date, foreignKey, index, pgTable, text, timestamp, unique, uuid,
} from 'drizzle-orm/pg-core'
import { operators, memberships } from './operators.js'
import { conversations } from './conversations.js'
import { vehicles } from './fleet.js'
import { operationsAnswer, operationsRequestKind, operationsRequestState } from './enums.js'

/**
 * Build plan step 30 — the Operations request queue.
 *
 * Section 6 of the MVP is unusually firm about this: "There is no automated
 * availability lookup, and none should be assumed." A person looks at the real
 * fleet calendar and answers. The agent's job is to ask well and relay the
 * answer exactly.
 *
 * `checked_at` is the column the whole table exists for. "An answer carries its
 * source and the time it was checked. An answer without a time checked cannot
 * be given to a customer." So it is nullable — an unanswered request genuinely
 * has no time — and every read path requires it to be present. A default of
 * `now()` would have made every row look verified, including the ones nobody
 * had looked at.
 *
 * `answer_valid_until` exists because of the next rule: "An expired answer is
 * rechecked before it is reused." Availability at 9am says nothing about 4pm,
 * and an agent quoting a morning answer in the evening is giving a stale
 * promise with a confident face.
 */
export const operationsRequests = pgTable(
  'operations_requests',
  {
    id: uuid().primaryKey().defaultRandom(),
    operatorId: uuid()
      .notNull()
      .references(() => operators.id, { onDelete: 'cascade' }),

    /** Null for a request raised by staff rather than by a conversation. */
    conversationId: uuid(),

    kind: operationsRequestKind().notNull(),

    /** The confirmed fleet vehicle, when the agent could match one. */
    vehicleId: uuid(),
    /**
     * What the customer actually asked for.
     *
     * Kept even when a vehicle matched, because "the yellow one" is what the
     * person answering needs to see to know they are checking the right car.
     */
    requestedVehicle: text(),

    startDate: date(),
    endDate: date(),

    state: operationsRequestState().notNull().default('open'),

    // --- the answer, all null until a person gives one ---
    answer: operationsAnswer(),
    /** What the person adds: "held for another booking until Thursday". */
    answerNote: text(),
    /**
     * Where they looked. A free field on purpose — this is a fleet calendar, a
     * phone call to the yard, a booking system. Naming it is what makes the
     * answer auditable later.
     */
    source: text(),
    /** The moment they checked. Never defaulted. See the note above. */
    checkedAt: timestamp({ withTimezone: true }),
    answeredByMembershipId: uuid(),
    /** After this, the answer must be rechecked rather than reused. */
    answerValidUntil: timestamp({ withTimezone: true }),

    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.conversationId, table.operatorId],
      foreignColumns: [conversations.id, conversations.operatorId],
      name: 'operations_requests_conversation_operator_fkey',
    }),
    foreignKey({
      columns: [table.vehicleId, table.operatorId],
      foreignColumns: [vehicles.id, vehicles.operatorId],
      name: 'operations_requests_vehicle_operator_fkey',
    }),
    foreignKey({
      columns: [table.answeredByMembershipId, table.operatorId],
      foreignColumns: [memberships.id, memberships.operatorId],
      name: 'operations_requests_answered_by_operator_fkey',
    }),
    unique('operations_requests_id_operator_key').on(table.id, table.operatorId),
    index('operations_requests_operator_state_idx').on(table.operatorId, table.state, table.createdAt),
    /** The lookup the agent does on every availability question. */
    index('operations_requests_answer_lookup_idx')
      .on(table.operatorId, table.vehicleId, table.startDate, table.endDate),
  ],
)

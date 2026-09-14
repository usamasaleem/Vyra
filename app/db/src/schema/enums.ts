import { pgEnum } from 'drizzle-orm/pg-core'

/**
 * Lead state is four independent fields. Section 18.6 is explicit that the
 * journey tables in sections 13-14 describe customer-visible situations and
 * "should not become one overloaded database enum".
 */
export const salesStage = pgEnum('sales_stage', [
  'new',
  'qualifying',
  'qualified',
  'options_sent',
  'quote_sent',
  'won',
  'lost',
])

/** Who owns the next reply. Exactly one at a time. */
export const handlerMode = pgEnum('handler_mode', ['ai', 'human'])

export const waitingReason = pgEnum('waiting_reason', [
  'none',
  'waiting_for_customer',
  'waiting_for_operations',
  'waiting_for_internal_approval',
])

export const bookingStatus = pgEnum('booking_status', [
  'none',
  'pending',
  'confirmed',
  'cancelled',
])

export const priority = pgEnum('priority', ['low', 'normal', 'high', 'urgent'])

export const membershipRole = pgEnum('membership_role', [
  'admin',
  'manager',
  'salesperson',
  'operations',
])

export const messageDirection = pgEnum('message_direction', ['inbound', 'outbound'])

/**
 * Non-text messages are stored and acknowledged, never silently dropped.
 * `unsupported` is a first-class kind for exactly that reason.
 */
export const messageKind = pgEnum('message_kind', [
  'text',
  'image',
  'audio',
  'video',
  'document',
  'sticker',
  'location',
  'contacts',
  'interactive',
  'template',
  'system',
  'unsupported',
])

/**
 * Provider acceptance, delivery and reading are distinct.
 *
 * `unknown` is a real terminal outcome, not a placeholder: if Meta accepted a
 * send but the response was lost, section 18.10 requires marking the outcome
 * unknown and reconciling against provider events rather than guessing.
 */
export const deliveryState = pgEnum('delivery_state', [
  'pending',
  /** Claimed by the dispatcher. Stops a second worker sending the same row. */
  'dispatching',
  /**
   * Suppressed before it reached Meta — a salesperson took over, the customer
   * corrected themselves, or policy changed. Section 18.11 requires pending AI
   * send intents to become cancelled rather than quietly failing.
   */
  'cancelled',
  'accepted',
  'sent',
  'delivered',
  'read',
  'failed',
  'unknown',
])

export const inboundEventStatus = pgEnum('inbound_event_status', [
  'received',
  'processing',
  'processed',
  'failed',
])

/** `dead` means retries are exhausted and a human must look at it. */
export const outboxStatus = pgEnum('outbox_status', [
  'pending',
  'published',
  'failed',
  'dead',
])

export const actorType = pgEnum('actor_type', ['user', 'ai', 'system', 'customer'])

/**
 * Provenance for an extracted fact. Section 7 of the full specification.
 *
 * `conflicting` is the one that earns its place: when a customer says Friday
 * and later says Saturday, the earlier value is not deleted. Both are kept and
 * marked, because section 15 requires summarising the conflict and asking which
 * is correct rather than silently overwriting.
 */
export const verificationState = pgEnum('verification_state', [
  'unknown',
  'customer_stated',
  'system_verified',
  'human_confirmed',
  'expired',
  'conflicting',
])

/** The fields a rental enquiry is made of. MVP section 3. */
export const enquiryField = pgEnum('enquiry_field', [
  'vehicle',
  'start_at',
  'end_at',
  'duration',
  'delivery_preference',
  'location',
  'residency',
  'driver_age',
  'budget',
  'special_requirements',
])

/** Broad classes a Dubai customer actually asks for. */
export const vehicleCategory = pgEnum('vehicle_category', [
  'exotic',
  'luxury',
  'suv',
  'sports',
  'convertible',
  'sedan',
])

/**
 * Whether a fleet record describes a real car.
 *
 * Same guard as knowledge_entries, for the same reason: a plausible invented
 * Ferrari is harder to spot than an obviously wrong one, and the agent quoting
 * a chassis number for a car that does not exist is worse than saying nothing.
 */
export const fleetProvenance = pgEnum('fleet_provenance', [
  'placeholder',
  'operator_confirmed',
])

/**
 * Why a conversation reached a person. Section 8 of the MVP lists the triggers;
 * these are those, grouped by what a salesperson does about them.
 */
export const handoffReason = pgEnum('handoff_reason', [
  'customer_asked',
  'qualified_lead',
  'discount_requested',
  'cannot_verify',
  'payment_or_dispute',
  'safety_or_accident',
  'non_text_message',
  'agent_uncertain',
  'turn_failed',
])

/**
 * `escalated` is distinct from `waiting` on purpose: a handoff nobody accepted
 * in time is a different thing from one that is merely new, and collapsing them
 * would hide exactly the failure escalation exists to surface.
 */
export const handoffState = pgEnum('handoff_state', [
  'waiting',
  'accepted',
  'escalated',
  'resolved',
])

export const operationsRequestKind = pgEnum('operations_request_kind', [
  'availability',
  'pricing',
])

export const operationsRequestState = pgEnum('operations_request_state', [
  'open',
  'answered',
  'cancelled',
])

/**
 * Section 6 of the MVP names these four exactly, and the fourth is the one that
 * matters: "An unknown answer is communicated as unknown, with a next action.
 * It is never softened into a maybe." There is deliberately no value between
 * unavailable and available.
 */
export const operationsAnswer = pgEnum('operations_answer', [
  'available',
  'unavailable',
  'pending_confirmation',
  'unknown',
])

/**
 * `superseded` is separate from `expired`: one means a newer revision replaced
 * it, the other that time ran out. A customer arguing about a price needs to
 * know which.
 */
export const quoteState = pgEnum('quote_state', [
  'draft',
  'approved',
  'sent',
  'expired',
  'superseded',
  'rejected',
])

/**
 * `needs_a_person` is a real outcome, not a failure state. A follow-up that
 * falls outside the 24-hour window cannot be sent free-form at all, and the MVP
 * requires a task rather than a silently dropped message.
 */
export const followUpState = pgEnum('follow_up_state', [
  'scheduled',
  'sent',
  'cancelled',
  'needs_a_person',
])

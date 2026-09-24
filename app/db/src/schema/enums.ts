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

/**
 * What happened to one customer's "yes".
 *
 * Distinct from `bookingStatus`, which says where a conversation stands.
 * `declined` has no counterpart there and is the one the conversation column
 * could never express: a request a person looked at and turned down is not the
 * same as one nobody has reached, and a customer waiting on an answer deserves
 * the difference to exist somewhere.
 *
 * Nothing here confirms anything on its own. Section 18.8 puts final booking
 * confirmation alongside refunds and payment verification as work that is not
 * an AI tool at all, so `requested` is the furthest the agent can move this
 * and every step past it carries a person's membership id.
 */
export const bookingState = pgEnum('booking_state', [
  'requested',
  'confirmed',
  'declined',
  'cancelled',
])

/**
 * What a customer owes, and what it is for.
 *
 * The deposit is its own kind rather than a line on the rental, because the
 * two behave nothing alike: one is earned and one is held and given back. A
 * refund against a rental is an argument; a refund against a deposit is
 * Tuesday.
 */
/** 'add_on': something extra the customer chose after booking — a chauffeur, more kilometres. */
export const paymentKind = pgEnum('payment_kind', ['rental', 'deposit', 'add_on'])

/**
 * Deliberately small, and deliberately without 'pending'.
 *
 * A payment is owed, taken, given back, or written off. "Pending" is what a
 * provider calls the seconds between a customer pressing pay and the webhook
 * arriving, and modelling it here would mean this table had opinions about a
 * provider that is not wired yet.
 */
export const paymentState = pgEnum('payment_state', [
  'due',
  'paid',
  'refunded',
  'cancelled',
])

/**
 * How it was taken, which in this market is mostly not a card.
 *
 * Bank transfer and cash are how a Dubai luxury rental deposit actually
 * moves, so they are first-class rather than an "other" somebody types into
 * a note. 'link' is for when a provider is wired and the customer pays
 * online.
 */
export const paymentMethod = pgEnum('payment_method', [
  'link',
  'bank_transfer',
  'cash',
  'card_in_person',
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
  /**
   * A thumbs-up on a message, which is a real customer action and not a
   * question.
   *
   * It used to land in `unsupported`, and the non-text path did what it does
   * for a voice note: apologised for not being able to read it and raised a
   * handoff. That took the conversation out of the agent's hands, so when the
   * customer asked a real question fifty minutes later nobody answered for six
   * minutes. A reaction cost a handoff and a silence.
   */
  'reaction',
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

/**
 * Lead state is four independent fields, never one flat status list.
 * Source: "sales agent mvp.md" section 7, "chat sales agent.md" section 18.6.
 *
 * A lead can be qualified, owned by a salesperson, waiting on Operations and
 * have no booking — all at once. A single enum cannot express that.
 */

/** Where the enquiry has reached commercially. */
export const SALES_STAGES = [
  'new',
  'qualifying',
  'qualified',
  'options_sent',
  'quote_sent',
  'won',
  'lost',
] as const
export type SalesStage = (typeof SALES_STAGES)[number]

/** Who owns the next reply. Exactly one at a time. */
export const HANDLER_MODES = ['ai', 'human'] as const
export type HandlerMode = (typeof HANDLER_MODES)[number]

/** What the conversation is blocked on, if anything. */
export const WAITING_REASONS = [
  'none',
  'waiting_for_customer',
  'waiting_for_operations',
  'waiting_for_internal_approval',
] as const
export type WaitingReason = (typeof WAITING_REASONS)[number]

/** Booking state as far as Sales can see it. Operations owns the truth. */
export const BOOKING_STATUSES = ['none', 'pending', 'confirmed', 'cancelled'] as const
export type BookingStatus = (typeof BOOKING_STATUSES)[number]

/**
 * Provenance for every extracted fact:
 * value + source message + extracted time + verification state.
 * Source: "chat sales agent.md" section 7.
 */
export const VERIFICATION_STATES = [
  'unknown',
  'customer_stated',
  'system_verified',
  'human_confirmed',
  'expired',
  'conflicting',
] as const
export type VerificationState = (typeof VERIFICATION_STATES)[number]

/**
 * The exact four answers Operations may return to Sales.
 * An unknown answer is communicated as unknown — never softened into a maybe.
 * Source: "operations agent mvp.md" section 6.
 */
export const AVAILABILITY_ANSWERS = [
  'available',
  'unavailable',
  'pending_confirmation',
  'unknown',
] as const
export type AvailabilityAnswer = (typeof AVAILABILITY_ANSWERS)[number]

/** Direction of a stored message. */
export const MESSAGE_DIRECTIONS = ['inbound', 'outbound'] as const
export type MessageDirection = (typeof MESSAGE_DIRECTIONS)[number]

/**
 * Provider acceptance is distinct from delivery and from reading.
 * `unknown` is a real outcome: Meta may have accepted a send whose response
 * was lost. Section 18.10 forbids pretending that ambiguity away.
 */
export const DELIVERY_STATES = [
  'pending',
  'accepted',
  'sent',
  'delivered',
  'read',
  'failed',
  'unknown',
] as const
export type DeliveryState = (typeof DELIVERY_STATES)[number]

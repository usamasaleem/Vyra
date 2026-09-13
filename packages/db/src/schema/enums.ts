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

/**
 * Schema v1 — build plan step 5.
 *
 * Every table carries `operator_id`. Retrofitting tenancy is the single most
 * expensive change on the roadmap because it touches every query written by
 * then, so it is not deferred for the pilot's single operator.
 */
export * from './enums.js'
export * from './operators.js'
export * from './conversations.js'
export * from './infrastructure.js'
export * from './knowledge.js'
export * from './enquiries.js'
export * from './fleet.js'
export * from './handoffs.js'
export * from './operations.js'
export * from './pricing.js'
export * from './follow-ups.js'

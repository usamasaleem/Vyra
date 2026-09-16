/**
 * The two lists a sign-up form and a team screen need, and neither of them is
 * a database concern.
 *
 * Here because a client component that imports them from @vyra/db drags the
 * postgres driver into the browser bundle — the build says so outright, in a
 * dependency trace ending at a form with two dropdowns on it. And because a
 * 'use server' module may only export functions, so they cannot live beside
 * the actions that use them either.
 */

/**
 * What a person may do, named by the permission rather than by seniority.
 *
 * The order is the order they are offered, and it deliberately does not imply
 * a ranking: operations is not junior to salesperson, it is a different job
 * that cannot reply to customers.
 */
export const MEMBERSHIP_ROLES = ['admin', 'manager', 'salesperson', 'operations'] as const
export type MembershipRole = (typeof MEMBERSHIP_ROLES)[number]

export function isMembershipRole(value: string): value is MembershipRole {
  return (MEMBERSHIP_ROLES as readonly string[]).includes(value)
}

/**
 * Where an operator is, which decides what "the 20th" means.
 *
 * A short list rather than every IANA zone: this is a Gulf product with a few
 * places its customers actually are, and six hundred options in a dropdown is
 * a worse answer than eight. Adding one is a one-line change.
 */
export const OPERATOR_TIMEZONES = [
  'Asia/Dubai', 'Asia/Riyadh', 'Asia/Qatar', 'Asia/Kuwait', 'Asia/Karachi',
  'Europe/London', 'Europe/Zurich', 'America/New_York',
] as const

export function isOperatorTimezone(value: string): boolean {
  return (OPERATOR_TIMEZONES as readonly string[]).includes(value)
}

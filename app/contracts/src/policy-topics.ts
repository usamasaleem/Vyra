/**
 * The subjects an operator publishes an approved answer for.
 *
 * This list is closed on purpose. It is what the `get_operator_policy` tool
 * accepts as a topic, and a closed list turns two different failures into two
 * different signals: asking for `deposit` and getting nothing back means the
 * operator has not answered that question yet, which is a real gap someone
 * should close. Asking for `depsoit` and getting nothing back would mean
 * nothing at all, and would look identical.
 *
 * These seven are the MVP set — the questions a Dubai rental customer asks
 * before they will commit to anything. Adding a topic is a deliberate act:
 * this list, then a published answer for each operator.
 */
export const POLICY_TOPICS = [
  'deposit',
  'included-kilometres',
  'driver-requirements-resident',
  'driver-requirements-visitor',
  'delivery-areas',
  'business-hours',
  'follow-up-timing',
] as const

export type PolicyTopic = (typeof POLICY_TOPICS)[number]

export function isPolicyTopic(value: string): value is PolicyTopic {
  return (POLICY_TOPICS as readonly string[]).includes(value)
}

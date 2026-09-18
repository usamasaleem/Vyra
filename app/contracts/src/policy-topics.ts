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
 * These six are the MVP set — the questions a Dubai rental customer asks
 * before they will commit to anything. Adding a topic is a deliberate act:
 * this list, then a published answer for each operator.
 *
 * Three topics used to live here and no longer do. `follow-up-message` and
 * `follow-up-message-2` are sentences the system sends, not answers it gives,
 * and they moved to AUTOMATED_MESSAGES — filed between the deposit and the
 * kilometre allowance, they went unwritten for the whole pilot while the
 * chases quietly became tasks for a person.
 *
 * `follow-up-timing` went with them and has no new home, because it was a note
 * to the team rather than anything a customer should hear — and being in this
 * list meant `get_operator_policy` could fetch it. It did: asked for a
 * discount, the model looked up the follow-up policy. The timing itself is
 * `operators.follow_up_after_minutes`, which is a number in Settings and is
 * what the scheduler has always actually used.
 */
export const POLICY_TOPICS = [
  'deposit',
  'included-kilometres',
  'driver-requirements-resident',
  'driver-requirements-visitor',
  'delivery-areas',
  'business-hours',
] as const

export type PolicyTopic = (typeof POLICY_TOPICS)[number]

export function isPolicyTopic(value: string): value is PolicyTopic {
  return (POLICY_TOPICS as readonly string[]).includes(value)
}

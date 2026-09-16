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
  /**
   * When to chase. A description of the rule, read by people.
   *
   * Distinct from `follow-up-message` below, and they were not always. The
   * sending code took this answer and used it as the body of the message,
   * which is fine while the operator happens to have written a sentence that
   * reads as one and a catastrophe otherwise. The pilot's said "Follow up once
   * after four hours if the customer has not replied, and once more the
   * following day" — and that was three hours from being sent to a customer on
   * the operator's own number.
   *
   * One field cannot be both the rule and the words. So it is two.
   */
  'follow-up-timing',
  /** The words themselves, sent verbatim. Nothing composes this. */
  'follow-up-message',
  /**
   * And the second chase, which has to say something the first did not.
   *
   * One answer reused for every attempt is what produced two identical
   * messages thirty minutes apart. A machine repeats itself; a salesperson
   * following up has a new reason to be in touch.
   */
  'follow-up-message-2',
] as const

export type PolicyTopic = (typeof POLICY_TOPICS)[number]

export function isPolicyTopic(value: string): value is PolicyTopic {
  return (POLICY_TOPICS as readonly string[]).includes(value)
}

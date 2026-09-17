/**
 * Whether a message is plainly going to need the fleet.
 *
 * Measured: a turn takes 4.5 seconds with no tool call and 7.6 with one,
 * because a tool call means a second trip to the model. Nearly every one of
 * those second trips is search_vehicles, and the fleet it returns is something
 * we could have looked up before asking.
 *
 * So this decides whether to look it up in advance. It is a guess and it is
 * allowed to be wrong in both directions, which is what makes a keyword rule
 * adequate where it would not be for anything that reaches a customer:
 *
 *   wrong yes  a database read nobody needed, and a paragraph of fleet in the
 *              instructions that the model has no reason to mention
 *   wrong no   the turn takes as long as it takes today
 *
 * Neither is a wrong answer to a customer, which is the only kind of error
 * this project treats as expensive.
 */

const ABOUT_THE_FLEET: RegExp[] = [
  // What is on offer at all.
  /\b(?:car|cars|vehicle|vehicles|fleet|range|models?)\b/i,
  // Renting one.
  /\b(?:rent|rental|hire|book|booking|available|availability)\b/i,
  // What it costs. "How much" without a noun is nearly always this.
  /\b(?:price|prices|pricing|rate|rates|cost|costs|how much|per day|cheapest|dearest|expensive|budget)\b/i,
  // A kind of car rather than a name.
  /\b(?:suv|sports|convertible|sedan|saloon|exotic|luxury|supercar|4x4)\b/i,
  // The marques this market is made of. A customer naming one is asking about
  // it, whatever else the sentence says.
  /\b(?:lambo|lamborghini|ferrari|rolls|royce|bentley|porsche|mclaren|maserati|aston|bugatti|mercedes|bmw|audi|range rover|urus|huracan|huracán|cullinan|g\s?63)\b/i,
  // Being shown one.
  /\b(?:show|see|pictures?|photos?|images?)\b/i,
  /**
   * Asking for more of what they were already sent. "can you send again" was
   * about a car and matched nothing here, so the fleet was never looked up,
   * so nothing downstream knew which car — and the agent promised to resend
   * photographs it then did not send.
   */
  /\b(?:send|resend|again|angle|angles)\b/i,
  /**
   * Referring to the fleet without naming it, which is most of how people do
   * it once the conversation has started. Every one of these was a real
   * message the first version of this rule missed.
   */
  /\bwhich (?:one|car|of them|of these)\b/i,
  /\bwhat (?:do you have|have you got|else)\b/i,
  /\ba day\b/i,
  // How a customer describes a car when they cannot name one.
  /\b(?:sporty|fast|loud|comfortable|family|roomy)\b/i,
]

export function mightNeedTheFleet(body: string | null): boolean {
  if (body === null || body.trim() === '') return false
  return ABOUT_THE_FLEET.some((p) => p.test(body))
}

/**
 * Whether this message could be asking whether a car is free.
 *
 * The prefetch hands the model every car and every rate, so the one thing
 * search_vehicles still knows that the prompt does not is availability on
 * specific dates. This decides whether to leave that door open.
 *
 * Deliberately generous. A false positive costs a round the turn would have
 * taken anyway; a false negative means a customer asking "is it free on the
 * 20th" is answered from a prompt that cannot know, which is the one thing
 * the availability design exists to prevent.
 */
const ABOUT_AVAILABILITY: RegExp[] = [
  /\b(?:available|availability|free|open|spare|taken|booked)\b/i,
  /\b(?:date|dates|day|days|week|weeks|weekend|month|night|nights)\b/i,
  /\b(?:today|tonight|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i,
  /\b(?:january|february|march|april|may|june|july|august|september|october|november|december)\b/i,
  // "the 20th", "19-21", "from the 3rd".
  /\b\d{1,2}(?:st|nd|rd|th)\b/i,
  /\b\d{1,2}\s*(?:to|-|–|until|till)\s*\d{1,2}\b/i,
  /\b\d{4}-\d{2}-\d{2}\b/,
  // Committing, which is the moment availability stops being optional.
  /\b(?:book|reserve|confirm|hold|take it|i'?ll take)\b/i,
]

export function mightNeedAvailability(body: string | null): boolean {
  if (body === null || body.trim() === '') return false
  return ABOUT_AVAILABILITY.some((pattern) => pattern.test(body))
}

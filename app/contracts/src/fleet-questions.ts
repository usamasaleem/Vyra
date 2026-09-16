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

/**
 * A customer asking for a better price.
 *
 * Section 8 of the MVP lists "a discount or exception is requested" as a
 * handoff trigger, and section 12 forbids the agent approving one. Those are
 * two halves of the same rule: the commercial decision belongs to a person, so
 * a person has to be told it was asked for.
 *
 * Detected with rules rather than left to the model, for the reason the eval
 * run demonstrated. Asked "can you do 3000 for the weekend instead?", the agent
 * replied "I'll check what we can do for AED 3,000 for the weekend" and called
 * no tool at all. Nobody was told, no task existed, and the customer had been
 * given a sentence that reads like the beginning of a negotiation.
 *
 * `discount_requested` has existed as a handoff reason since the queue was
 * built — with its own priority and its own label in the inbox — and nothing
 * has ever written it.
 *
 * Unlike an opt-out, a match does not stop the agent replying. Acknowledging
 * the ask and collecting the context is useful work, and section 17.5 asks for
 * exactly that. What the match guarantees is that the decision reaches a
 * person, whatever the model chose to do.
 */
export type DiscountRequest = { matched: string; reason: string }

const DISCOUNT_PATTERNS: RegExp[] = [
  /\bdiscount(?:s|ed)?\b/,
  /\bbest (?:price|rate|deal|offer|you can do)\b/,
  /\bspecial (?:price|rate|deal)\b/,
  /\bnegotiab/,
  // "cheaper", but never "cheapest" — "what's your cheapest car" is a question
  // about the fleet, not a request for a concession.
  /\bcheaper\b/,
  // "offer 20% off", "10 percent off" — a number off is a discount whatever
  // else the sentence says. Missed in simulation on a customer's second push,
  // who then said "otherwise I'll have to pass".
  // "Off" is required: "is the 5% VAT included?" asks about tax, not for a concession.
  /\b\d{1,2}\s?(?:%|percent|per cent)\s?(?:off|discount)\b/,
  // The price as the objection, without asking for anything by name.
  /\btoo (?:expensive|much|pricey|high|steep)\b/,
  /\b(?:quite|very|so|bit|little) (?:high|expensive|pricey|steep)\b/,
  /\bany (?:deal|deals|offer|offers)\b/,
  /\b(?:do|go) better\b/,
  /\b(?:lower|reduce|drop|bring down)\b[^.?!]{0,20}\b(?:price|rate|it)\b/,
  /\bprice\b[^.?!]{0,20}\b(?:down|flexible)\b/,
  // "can you do 3000", "can you do it for 2500" — an offer of a specific
  // number is the commonest form and names no discount word at all.
  /\bcan (?:you|u) do\b[^.?!]{0,20}\d/,
  /\bfor (?:just |only )?\d[\d,]*\s*(?:aed|dhs|dirhams?)?\s*(?:instead|total)\b/,
  /**
   * ⚠️ Model-written, and needs a native speaker — the same warning the opt-out
   * patterns carry. خصم is unambiguous; the rest of Arabic price bargaining is
   * not, and this list is certainly incomplete rather than wrong.
   */
  /خصم/,
  /(?:أفضل|احسن|أحسن) سعر/,
]

const normalise = (text: string) =>
  text.toLowerCase().replace(/[’']/g, "'").replace(/\s+/g, ' ').trim()

export function detectDiscountRequest(text: string | null): DiscountRequest | null {
  if (text === null || text.trim() === '') return null
  const normalised = normalise(text)
  for (const pattern of DISCOUNT_PATTERNS) {
    const match = normalised.match(pattern)
    if (match !== null) {
      return {
        matched: match[0],
        reason: 'The customer asked for a discount or a better price',
      }
    }
  }
  return null
}

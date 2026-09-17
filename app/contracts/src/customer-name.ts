/**
 * Whether a WhatsApp profile name is something you could call a person.
 *
 * The agent has never known the customer's name: `contacts.display_name` is
 * fetched from the webhook on every turn and dropped at the prompt boundary.
 * Handing it over is one line — deciding whether it is a name is the part that
 * needs thought, because a WhatsApp profile name is whatever somebody typed.
 *
 * In the pilot's own contact table it is the phone number. Elsewhere it is an
 * emoji, a company, a slogan, or blank. "Hello +971 50 123 4567" is worse than
 * no greeting, and so is "Hi 🌹🌹🌹".
 *
 * Deliberately conservative: when it is not clearly a name, the agent is told
 * nothing and writes the reply it would have written anyway. A missed greeting
 * costs warmth. A wrong one costs credibility.
 */

/** Long enough to be a tagline rather than a name. */
const TOO_LONG = 40

/** Business suffixes — a company is not a person, however friendly. */
const A_COMPANY =
  /\b(?:llc|l\.l\.c|fzco|fz-?llc|ltd|limited|inc|co|corp|group|trading|rent(?:al|als)?|tourism|motors|cars?)\b/i

export function usableName(raw: string | null | undefined): string | null {
  if (raw == null) return null
  const name = raw.replace(/\s+/g, ' ').trim()
  if (name === '') return null
  if (name.length > TOO_LONG) return null

  /**
   * A phone number in any of the shapes people save them in — which is what
   * WhatsApp shows when somebody has never set a profile name, and is the
   * single most common case.
   */
  if (/^[+\d][\d\s().+-]*$/.test(name)) return null

  // Needs letters somebody could say out loud. Emoji, symbols and digits are
  // not a name, and `\p{L}` counts Arabic and Cyrillic as readily as Latin.
  const letters = [...name].filter((ch) => /\p{L}/u.test(ch)).length
  if (letters < 2) return null

  // Mostly decoration with a letter or two in it — "✨A✨", "🌹Rosa🌹" keeps.
  if (letters < name.replace(/\s/g, '').length / 2) return null

  if (A_COMPANY.test(name)) return null

  return name
}

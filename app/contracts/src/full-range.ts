/**
 * Pointing somebody at the whole fleet, when the conversation cannot hold it.
 *
 * A hundred and twenty cars fit in no WhatsApp message — ten rows in a list,
 * forty as many as the model is handed to read. For the customer who says
 * "just show me everything", a web page is the only honest answer.
 *
 * It is a last resort and the reason is measured rather than assumed. A CTA
 * button does not open a panel over the chat, whatever the hope was: on a real
 * device it launches the phone's default browser as a separate app. So a link
 * is not a slightly worse message, it is an exit — the photographs, the prices
 * and the half-answered question all go behind an app switch and a back
 * gesture the customer may not make.
 *
 * Which is why this is detected from the reply rather than offered by us. The
 * model decides the conversation has run out of room and says so; this makes
 * the sentence true, the same way a claimed photograph attaches one.
 */

const OFFERS_THE_RANGE: RegExp[] = [
  /\b(?:full|whole|entire|complete)\s+(?:range|fleet|selection|list|line-?up)\b/i,
  /\b(?:all|every)\s+(?:of\s+)?(?:our|the)\s+cars\b/i,
  /\b(?:our|the)\s+(?:web ?site|site|online)\b/i,
  /\bbrowse\b[^.?!]{0,25}\b(?:them all|everything|the fleet|online)\b/i,
]

export function offersTheFullRange(reply: string | null): boolean {
  if (reply === null || reply.trim() === '') return false
  return OFFERS_THE_RANGE.some((p) => p.test(reply))
}

/**
 * Only an https address, and only one somebody entered on the settings screen.
 *
 * The model never sees this and never types it — the same rule as a
 * photograph's URL, for the same reason. What the check is really guarding is
 * an operator pasting something odd into a form, and the cost of getting it
 * wrong is a customer sent somewhere the operator did not mean.
 */
export function usableWebsite(url: string | null | undefined): string | null {
  if (typeof url !== 'string' || url.trim() === '') return null
  const trimmed = url.trim()
  try {
    const parsed = new URL(trimmed)
    return parsed.protocol === 'https:' ? parsed.toString() : null
  } catch {
    return null
  }
}

/** Twenty characters, like every other CTA WhatsApp draws. */
export const FULL_RANGE_LABEL = 'See all our cars'

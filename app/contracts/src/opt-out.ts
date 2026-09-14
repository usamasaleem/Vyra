/**
 * A customer telling the business to stop messaging them.
 *
 * A rule, not a tool, and not a model judgement. The eval run showed a model
 * handling "stop" impeccably and uselessly: it replied "Understood. I won't
 * message you again" and called nothing, because deciding to honour an opt-out
 * is not a decision that should depend on a model deciding to.
 *
 * The bias here is the opposite of `detectStopSignal`.
 *
 * A stop signal errs toward firing: a false one costs a salesperson a glance.
 * An opt-out is close to irreversible in effect — the dispatcher then refuses
 * every send to that contact, staff included — so a false one silently ends a
 * live conversation with a customer who is still trying to rent a car, and
 * nobody finds out. So these patterns are narrow and deliberately literal.
 *
 * That is why "not interested" is absent. It is a lost lead, not an opt-out,
 * and the two have completely different consequences.
 *
 * ⚠️ The Arabic patterns are model-written and need a native speaker, for the
 * same reason the Arabic eval cases do. Here the cost of a wrong one is higher
 * than a bad test: a phrase that should not match will silence a customer.
 */

export type OptOutDetection = {
  /** The phrase that matched, so the decision can be explained and reversed. */
  matched: string
  /** Short description for the audit record and the handoff reason. */
  reason: string
}

const OPT_OUT_PATTERNS: RegExp[] = [
  /**
   * A lone "stop" is the convention every messaging platform teaches, so it
   * has to work. Anchored to the whole message on purpose: an unanchored
   * \bstop\b matches "stop by the showroom" and "can you stop the charge",
   * one of which is a customer asking to visit and the other a dispute.
   */
  /^(?:stop|unsubscribe|end|cancel)$/,

  /\bstop (?:messaging|texting|contacting|writing|sending|calling)\b/,
  /**
   * "Don't message me" has to end the message or carry a word of finality.
   *
   * Without that, this fired on "don't call me before noon, message is fine" —
   * a customer saying which channel they prefer, which my own false-positive
   * test caught before it silenced anyone. "Call" is gone from the list
   * entirely: on WhatsApp "don't call me" most often means "text instead",
   * which is the opposite of wanting no contact.
   */
  /\b(?:don'?t|do not|never) (?:message|text|contact|write to) (?:me |us )?(?:again|anymore|any more|ever)\b/,
  /\b(?:don'?t|do not|never) (?:message|text|contact|write to)(?: me| us)?$/,
  /\bunsubscribe\b/,
  /\bopt(?:ing)? out\b/,
  /\b(?:remove|take) me (?:off|from|out of)\b/,
  /\bdelete my (?:number|details|data|contact)\b/,
  /\bleave me alone\b/,
  /\bno longer (?:wish|want) to (?:be contacted|receive|hear)\b/,
  /\b(?:stop|quit) (?:the |these |your )?(?:messages|texts|spam)\b/,

  // Arabic — see the warning above.
  /^(?:توقف|إلغاء الاشتراك|الغاء الاشتراك)$/,
  /لا ترسل(?:وا)? لي/,
  /لا تراسلني/,
  /احذف رقمي/,
  /الغاء الاشتراك|إلغاء الاشتراك/,
]

const normalise = (text: string) =>
  text.toLowerCase().replace(/[’']/g, "'").replace(/\s+/g, ' ').trim().replace(/[.!]+$/, '')

/**
 * Runs before any model call, and a match is final.
 *
 * Returns null rather than a score. There is no partial opt-out: either the
 * customer asked to be left alone or they did not, and a confidence number
 * here would only invite someone to pick a threshold.
 */
export function detectOptOut(text: string): OptOutDetection | null {
  const normalised = normalise(text)
  for (const pattern of OPT_OUT_PATTERNS) {
    const match = normalised.match(pattern)
    if (match !== null) {
      return { matched: match[0], reason: 'The customer asked not to be messaged again' }
    }
  }
  return null
}

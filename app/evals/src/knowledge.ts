/**
 * Approved sales knowledge — the shape, and a guard against publishing fiction.
 *
 * Section 5 of the MVP requires that answers come from operator-approved
 * content and that the source of any important answer is recorded. Section 8
 * of the full specification warns that Dubai rental terms vary widely between
 * operators, so nothing here can be inferred from another company.
 *
 * That creates a hazard during development: placeholder answers are needed to
 * build and evaluate anything, and a placeholder that survives into production
 * is an invented commitment made to a real customer. So provenance is a
 * required field rather than a comment, and `assertPublishable` refuses
 * anything still marked placeholder. When step 20 builds the knowledge store,
 * its publish path calls this.
 */

export type KnowledgeProvenance =
  /** A named person at the operator confirmed this wording. */
  | 'operator-confirmed'
  /** Invented to unblock development. Must never reach a customer. */
  | 'placeholder'

export type KnowledgeEntry = {
  topic: string
  /** The shape of question this answers, for retrieval and for review. */
  covers: string
  answer: string
  provenance: KnowledgeProvenance
  /** Required once confirmed: who at the operator said so, and when. */
  confirmedBy?: string
  confirmedAt?: string
  /** The eval case this unblocks, so the two stay tied together. */
  unblocksEvalCase?: string
}

export class PlaceholderKnowledgeError extends Error {
  readonly topics: string[]
  constructor(topics: string[]) {
    super(
      `Refusing to publish ${topics.length} placeholder answer(s): ${topics.join(', ')}. ` +
        `These were invented during development and have not been confirmed by the operator.`,
    )
    this.name = 'PlaceholderKnowledgeError'
    this.topics = topics
  }
}

/**
 * Throws unless every entry has been confirmed by the operator.
 *
 * The check is deliberately unconditional — no environment flag, no override.
 * A switch that lets placeholder content through in "just this one case" is how
 * it reaches a customer.
 */
export function assertPublishable(entries: readonly KnowledgeEntry[]): void {
  const unconfirmed = entries.filter((e) => e.provenance !== 'operator-confirmed')
  if (unconfirmed.length > 0) {
    throw new PlaceholderKnowledgeError(unconfirmed.map((e) => e.topic))
  }
  const missingAttribution = entries.filter((e) => !e.confirmedBy || !e.confirmedAt)
  if (missingAttribution.length > 0) {
    throw new PlaceholderKnowledgeError(
      missingAttribution.map((e) => `${e.topic} (confirmed by whom, and when?)`),
    )
  }
}

/** What still needs asking, for a report rather than a surprise. */
export function openQuestions(entries: readonly KnowledgeEntry[]): KnowledgeEntry[] {
  return entries.filter((e) => e.provenance === 'placeholder')
}

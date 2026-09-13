import type { QueryRunner, Transactor } from '../runner.js'

/**
 * Build plan step 20 — approved sales knowledge.
 *
 * Three operations, deliberately separate: draft, publish, read. Publishing is
 * an explicit act (MVP section 5: "allow an authorised staff member to update
 * and publish sales knowledge"), never a side effect of editing — so nobody
 * changes an answer and discovers it went live.
 */

export type KnowledgeDraft = {
  operatorId: string
  topic: string
  covers?: string | null
  answer: string
  /** Who at the operator confirmed this wording, if anyone has yet. */
  confirmedBy?: string | null
}

/**
 * Creates the next version of a topic. Always a draft — never published, and
 * never touching whatever answer is currently live.
 */
const DRAFT_SQL = `
  insert into knowledge_entries (operator_id, topic, covers, answer, version, provenance, confirmed_by, confirmed_at)
  select $1, $2, $3, $4,
         coalesce((select max(version) from knowledge_entries where operator_id = $1 and topic = $2), 0) + 1,
         case when $5::text is null then 'placeholder' else 'operator_confirmed' end::knowledge_provenance,
         $5,
         case when $5::text is null then null else now() end
  returning id, version, provenance
`

export async function draftKnowledge(
  run: QueryRunner,
  input: KnowledgeDraft,
): Promise<{ id: string; version: number; provenance: string }> {
  const rows = await run(DRAFT_SQL, [
    input.operatorId,
    input.topic,
    input.covers ?? null,
    input.answer,
    input.confirmedBy ?? null,
  ])
  const row = rows[0]!
  return {
    id: row['id'] as string,
    version: Number(row['version']),
    provenance: row['provenance'] as string,
  }
}

export type PublishResult =
  | { published: true; version: number; supersededVersion: number | null }
  | { published: false; reason: 'not_found' | 'not_confirmed' | 'already_published' }

/**
 * Publishing: close the current version, then open the new one, in that order,
 * inside one transaction.
 *
 * This cannot be a single statement. Data-modifying CTEs all see the same
 * snapshot, so the partial unique index that permits one current version per
 * topic still sees the old row as current at the moment the new one is
 * published, and rejects it. The steps genuinely need ordering — which is what
 * a transaction is for, and why the atomicity still holds: between the two
 * updates there is never a moment another session can observe two approved
 * answers, or none.
 *
 * The check constraint on the table refuses unconfirmed content regardless of
 * what this function does. This returns a reason rather than throwing so the
 * inbox can say which topic still needs the operator.
 */
export async function publishKnowledge(
  transact: Transactor,
  input: { entryId: string; operatorId: string; membershipId: string },
): Promise<PublishResult> {
  return transact(async (tx) => {
    const found = await tx(
      `select id, topic, version, provenance::text as provenance, confirmed_by, published_at
       from knowledge_entries
       where id = $1 and operator_id = $2
       for update`,
      [input.entryId, input.operatorId],
    )
    const target = found[0]
    if (target === undefined) return { published: false, reason: 'not_found' } as const
    if (target['published_at'] != null) return { published: false, reason: 'already_published' } as const
    if (target['provenance'] !== 'operator_confirmed' || target['confirmed_by'] == null) {
      return { published: false, reason: 'not_confirmed' } as const
    }

    // Close the current version first, so the index sees one current row.
    const superseded = await tx(
      `update knowledge_entries
       set effective_to = now()
       where operator_id = $1 and topic = $2 and id <> $3
         and published_at is not null and effective_to is null
       returning version`,
      [input.operatorId, target['topic'], input.entryId],
    )

    const published = await tx(
      `update knowledge_entries
       set published_at = now(), effective_from = now(), published_by_membership_id = $2
       where id = $1
       returning version`,
      [input.entryId, input.membershipId],
    )

    return {
      published: true,
      version: Number(published[0]!['version']),
      supersededVersion:
        superseded[0] === undefined ? null : Number(superseded[0]['version']),
    } as const
  })
}

export type ApprovedAnswer = {
  topic: string
  answer: string
  version: number
  confirmedBy: string
  effectiveFrom: Date
}

/**
 * The answer that was approved at a given moment — now by default.
 *
 * Takes a time because "what did we tell them on the 3rd" is a real question
 * when a customer quotes an old answer back. Returns null rather than a
 * fallback: section 5 requires the agent to show uncertainty when approved
 * information is missing, and a fallback would hide that.
 */
const APPROVED_SQL = `
  select topic, answer, version, confirmed_by, effective_from
  from knowledge_entries
  where operator_id = $1
    and topic = $2
    and published_at is not null
    and effective_from <= $3::timestamptz
    and (effective_to is null or effective_to > $3::timestamptz)
  order by version desc
  limit 1
`

export async function getApprovedAnswer(
  run: QueryRunner,
  operatorId: string,
  topic: string,
  at: Date = new Date(),
): Promise<ApprovedAnswer | null> {
  const rows = await run(APPROVED_SQL, [operatorId, topic, at.toISOString()])
  const row = rows[0]
  if (row === undefined) return null
  return {
    topic: row['topic'] as string,
    answer: row['answer'] as string,
    version: Number(row['version']),
    confirmedBy: row['confirmed_by'] as string,
    effectiveFrom: new Date(row['effective_from'] as string),
  }
}

/** Everything an operator has, published or not — the editing surface. */
export async function listKnowledge(
  run: QueryRunner,
  operatorId: string,
): Promise<Array<Record<string, unknown>>> {
  return run(
    `select id, topic, covers, answer, version, provenance::text as provenance,
            confirmed_by, published_at, effective_from, effective_to
     from knowledge_entries
     where operator_id = $1
     order by topic, version desc`,
    [operatorId],
  )
}

import type { QueryRunner, Transactor } from '../runner.js'

/**
 * Build plan step 21 — recording extracted facts with their evidence.
 *
 * The rule that shapes all of this is section 15: when a customer corrects
 * themselves, do not silently overwrite. So recording a new value for a field
 * that already has one supersedes rather than replaces, and both rows remain.
 * What the customer said on Tuesday is still answerable on Friday.
 */

export const ENQUIRY_FIELDS = [
  'vehicle', 'start_at', 'end_at', 'duration', 'delivery_preference',
  'location', 'residency', 'driver_age', 'budget', 'special_requirements',
] as const
export type EnquiryField = (typeof ENQUIRY_FIELDS)[number]

/** The five fields MVP section 3 requires before an enquiry counts as qualified. */
export const REQUIRED_FOR_QUALIFICATION: readonly EnquiryField[] = [
  'vehicle', 'start_at', 'delivery_preference',
] as const

export type FieldObservation = {
  field: EnquiryField
  /** The normalised value. */
  value: string
  /** What the customer actually typed, if different. */
  originalWording?: string | null
  sourceMessageId?: string | null
  verificationState?: 'customer_stated' | 'system_verified' | 'human_confirmed' | 'unknown'
}

export type RecordedField = {
  field: EnquiryField
  value: string
  /** True when this replaced a different previous value — a correction. */
  corrected: boolean
  previousValue: string | null
}

/**
 * Records observations, superseding any earlier value for the same field.
 *
 * Re-stating the same value is not a correction and does not churn the record:
 * a customer repeating "Friday" should not look like they changed their mind.
 */
export async function recordFields(
  transact: Transactor,
  input: { operatorId: string; enquiryId: string; observations: readonly FieldObservation[] },
): Promise<RecordedField[]> {
  return transact(async (tx) => {
    const recorded: RecordedField[] = []

    for (const observation of input.observations) {
      const existing = await tx(
        `select id, value from field_evidence
         where enquiry_id = $1 and operator_id = $2 and field = $3::enquiry_field
           and superseded_at is null
         for update`,
        [input.enquiryId, input.operatorId, observation.field],
      )
      const previous = existing[0]

      // Same value restated: leave the original row and its extraction time.
      if (previous !== undefined && previous['value'] === observation.value) {
        recorded.push({
          field: observation.field,
          value: observation.value,
          corrected: false,
          previousValue: null,
        })
        continue
      }

      /**
       * Close the old value before inserting the new one.
       *
       * The index permitting one live value per field is checked as each row
       * is written, so inserting first would collide with the row that is
       * about to be superseded. Ordering inside a transaction is what makes
       * the swap possible — the same constraint that shaped publishKnowledge.
       */
      if (previous !== undefined) {
        await tx(
          `update field_evidence
           set superseded_at = now(), verification_state = 'conflicting'
           where id = $1`,
          [previous['id']],
        )
      }

      const inserted = await tx(
        `insert into field_evidence
           (operator_id, enquiry_id, field, value, original_wording, source_message_id, verification_state)
         values ($1, $2, $3::enquiry_field, $4, $5, $6, $7::verification_state)
         returning id`,
        [
          input.operatorId, input.enquiryId, observation.field, observation.value,
          observation.originalWording ?? null, observation.sourceMessageId ?? null,
          observation.verificationState ?? 'customer_stated',
        ],
      )

      if (previous !== undefined) {
        // Point the superseded row at what replaced it, so the chain of what
        // the customer said is followable in both directions.
        await tx(
          `update field_evidence set superseded_by_id = $2 where id = $1`,
          [previous['id'], inserted[0]!['id']],
        )
      }

      recorded.push({
        field: observation.field,
        value: observation.value,
        corrected: previous !== undefined,
        previousValue: previous === undefined ? null : (previous['value'] as string),
      })
    }

    await tx(`update enquiries set updated_at = now() where id = $1 and operator_id = $2`,
      [input.enquiryId, input.operatorId])

    return recorded
  })
}

export type EnquiryFieldValue = {
  field: EnquiryField
  value: string
  originalWording: string | null
  sourceMessageId: string | null
  extractedAt: Date
  verificationState: string
}

/** The live values — what the enquiry currently says. */
export async function getEnquiryFields(
  run: QueryRunner,
  operatorId: string,
  enquiryId: string,
): Promise<EnquiryFieldValue[]> {
  const rows = await run(
    `select field::text as field, value, original_wording, source_message_id,
            extracted_at, verification_state::text as verification_state
     from field_evidence
     where enquiry_id = $1 and operator_id = $2 and superseded_at is null
     order by field`,
    [enquiryId, operatorId],
  )
  return rows.map((r) => ({
    field: r['field'] as EnquiryField,
    value: r['value'] as string,
    originalWording: (r['original_wording'] as string) ?? null,
    sourceMessageId: (r['source_message_id'] as string) ?? null,
    extractedAt: new Date(r['extracted_at'] as string),
    verificationState: r['verification_state'] as string,
  }))
}

/**
 * Everything the customer has said about a field, newest first.
 *
 * This is what makes a conflict explainable: "you mentioned Friday earlier and
 * Saturday just now — which should I use?" needs both, with their times.
 */
export async function getFieldHistory(
  run: QueryRunner,
  operatorId: string,
  enquiryId: string,
  field: EnquiryField,
): Promise<Array<{ value: string; originalWording: string | null; extractedAt: Date; superseded: boolean }>> {
  const rows = await run(
    `select value, original_wording, extracted_at, superseded_at
     from field_evidence
     where enquiry_id = $1 and operator_id = $2 and field = $3::enquiry_field
     order by extracted_at desc`,
    [enquiryId, operatorId, field],
  )
  return rows.map((r) => ({
    value: r['value'] as string,
    originalWording: (r['original_wording'] as string) ?? null,
    extractedAt: new Date(r['extracted_at'] as string),
    superseded: r['superseded_at'] != null,
  }))
}

/** What is still missing before this enquiry could be called qualified. */
export async function missingFields(
  run: QueryRunner,
  operatorId: string,
  enquiryId: string,
): Promise<EnquiryField[]> {
  const present = new Set((await getEnquiryFields(run, operatorId, enquiryId)).map((f) => f.field))
  const missing = REQUIRED_FOR_QUALIFICATION.filter((f) => !present.has(f))
  // An end date or a duration satisfies the same requirement.
  if (!present.has('end_at') && !present.has('duration')) missing.push('end_at')
  return missing
}

/** Finds or creates the enquiry for a conversation. */
export async function ensureEnquiry(
  run: QueryRunner,
  operatorId: string,
  conversationId: string,
): Promise<string | null> {
  const rows = await run(
    `with existing as (
       select id from enquiries where conversation_id = $2 and operator_id = $1
       order by created_at limit 1
     ),
     created as (
       insert into enquiries (operator_id, conversation_id)
       select v.operator_id, v.id from conversations v
       where v.id = $2 and v.operator_id = $1 and not exists (select 1 from existing)
       returning id
     )
     select coalesce((select id from existing), (select id from created)) as id`,
    [operatorId, conversationId],
  )
  return (rows[0]?.['id'] as string) ?? null
}

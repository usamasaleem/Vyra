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

/**
 * The enquiry this conversation is about now, creating one if there is none.
 *
 * Two things were wrong here, and they only became harmful once the prompt
 * started reading the enquiry back to the customer.
 *
 * It took `order by created_at limit 1` — the **oldest** enquiry, forever. The
 * schema says the opposite is intended: "a customer can have several — a
 * Lamborghini for the weekend and a chauffeur car for the airport run are two
 * enquiries in one thread." Newest is what "the enquiry under discussion"
 * means.
 *
 * And nothing ever started a second one, because the insert was guarded on
 * there being none at all. A conversation is unique per contact and reopens
 * forever, so the enquiry created on somebody's first ever message was still
 * the live one a year later. Harmless while nothing read it; actively
 * misleading now that systemPromptFor says "This enquiry already has: they
 * want the Ferrari; it starts 19 September … do not ask for them again."
 * Delivered in November, that is a confident lie about a rental that finished.
 *
 * So an enquiry whose dates have passed is spent, and the next message starts
 * a fresh one. The test is deliberately the recorded dates rather than age or
 * a stage column: an enquiry for next March is not stale in January however
 * long ago it was opened, and `enquiries.stage` has never been written by
 * anything. The old rows stay exactly as they are — that is what made the
 * quote explainable in the first place.
 *
 * What this does not do: split "a Lamborghini for the weekend and a chauffeur
 * car for the airport" into two live enquiries. That needs the model to say so
 * and there is no tool for it, so a second concurrent rental still overwrites
 * the first, as it always has.
 */
export async function ensureEnquiry(
  run: QueryRunner,
  operatorId: string,
  conversationId: string,
): Promise<string | null> {
  const rows = await run(
    `with live as (
       select e.id from enquiries e
       where e.conversation_id = $2 and e.operator_id = $1
         and coalesce(
               (select max(fe.value::date) from field_evidence fe
                 where fe.enquiry_id = e.id and fe.superseded_at is null
                   and fe.field in ('start_at', 'end_at')
                   -- Guard the cast: the column is text and only a resolved
                   -- date is safe to compare.
                   and fe.value ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
               current_date
             ) >= current_date
       order by e.created_at desc
       limit 1
     ),
     created as (
       insert into enquiries (operator_id, conversation_id)
       select v.operator_id, v.id from conversations v
       where v.id = $2 and v.operator_id = $1 and not exists (select 1 from live)
       returning id
     )
     select coalesce((select id from live), (select id from created)) as id`,
    [operatorId, conversationId],
  )
  return (rows[0]?.['id'] as string) ?? null
}

/**
 * The stage an enquiry has plainly reached, from what is on file.
 *
 * Derived rather than decided. Nothing in this system ever advanced
 * sales_stage: the only code that wrote it was the manual won/lost close-out,
 * so a conversation ninety-four messages deep with a named car, confirmed
 * dates, a calculated quote and an escalated discount was still sitting at
 * 'new'. Which made the qualification rate on the reports page structurally
 * zero, and the inbox's stage filter unable to filter anything.
 *
 * A judgement would have been the wrong shape for it. Whether an enquiry is
 * qualified is not an opinion — section 3 lists the fields, and either they
 * are recorded or they are not.
 *
 * Only ever forward. 'won' and 'lost' are somebody's decision and nothing here
 * may talk them out of it; a customer who changes their mind after being
 * marked lost is a person reopening a lead, not a row to quietly rewrite.
 */
const STAGE_ORDER = [
  'new', 'qualifying', 'qualified', 'options_sent', 'quote_sent',
] as const

export type DerivedStage = (typeof STAGE_ORDER)[number]

export function stageFromEvidence(input: {
  fields: ReadonlyArray<{ field: string }>
  /** A quote has been calculated and sent to the customer. */
  quoteSent: boolean
  /** The agent has named specific cars to them. */
  optionsSent: boolean
}): DerivedStage {
  if (input.quoteSent) return 'quote_sent'

  const has = (name: string) => input.fields.some((f) => f.field === name)
  const qualified = REQUIRED_FOR_QUALIFICATION.every((f) => has(f))

  if (qualified) return 'qualified'
  if (input.optionsSent) return 'options_sent'
  // Anything at all on file means somebody is being qualified rather than new.
  return input.fields.length > 0 ? 'qualifying' : 'new'
}

/**
 * Move the conversation to the stage its own evidence supports.
 *
 * Forwards only, and never out of a stage a person chose. The comparison is on
 * the listed order, so a stage outside it — won, lost — matches nothing and
 * the update does not apply.
 */
export async function advanceStage(
  run: QueryRunner,
  input: { operatorId: string; conversationId: string; stage: DerivedStage },
): Promise<{ moved: boolean; from: string | null }> {
  const rows = await run(
    `update conversations v set sales_stage = $3::sales_stage, updated_at = now()
     from (select array[${STAGE_ORDER.map((s) => `'${s}'`).join(',')}] as order) o
     where v.id = $1 and v.operator_id = $2
       and array_position(o.order, v.sales_stage::text) is not null
       and array_position(o.order, $3) > array_position(o.order, v.sales_stage::text)
     returning (select sales_stage::text from conversations where id = $1) as from_stage`,
    [input.conversationId, input.operatorId, input.stage],
  )
  return { moved: rows.length > 0, from: (rows[0]?.['from_stage'] as string) ?? null }
}

/**
 * What the agent still needs, and whether it may ask again.
 *
 * `missingFields` has existed since step 21 and is read in exactly one place:
 * the handoff packet, which tells a person what is missing once the
 * conversation has already been given away. The agent itself was never told.
 *
 * It showed. Live, it asked "what dates are you considering?", the customer
 * asked four questions of their own instead, and the agent answered all four
 * and never came back. Nine exchanges qualified nothing, and the enquiry kept
 * dates from five days earlier that were by then certainly wrong.
 *
 * The counting is the whole design. A salesperson asks again; a form asks
 * until somebody stops replying. Twice, spaced, then let it go — and if they
 * volunteer it later it is recorded like anything else.
 */

/** Asked at most this many times, ever. */
export const ASK_AT_MOST = 2

/**
 * And not in consecutive turns. Three revisions is roughly "answer what they
 * asked, let them reply, then come back to it" — close enough to how a person
 * paces it, and far enough from asking twice in a row.
 */
export const ASK_EVERY = 3

export type OutstandingQuestion = {
  field: EnquiryField
  /** How many times it has already been put to them. */
  timesAsked: number
}

export async function outstandingQuestions(
  run: QueryRunner,
  input: { operatorId: string; conversationId: string; enquiryId: string },
): Promise<OutstandingQuestion[]> {
  const missing = await missingFields(run, input.operatorId, input.enquiryId)
  if (missing.length === 0) return []

  const [row] = await run(
    `select revision, asked_for from conversations where id = $1 and operator_id = $2`,
    [input.conversationId, input.operatorId],
  )
  if (row === undefined) return []

  const revision = Number(row['revision'])
  const asked = (row['asked_for'] ?? {}) as Record<string, { times: number; revision: number }>

  return missing
    .map((field) => ({ field, record: asked[field] }))
    .filter(({ record }) => {
      if (record === undefined) return true
      if (record.times >= ASK_AT_MOST) return false
      return revision - record.revision >= ASK_EVERY
    })
    .map(({ field, record }) => ({ field, timesAsked: record?.times ?? 0 }))
}

/**
 * Counted when the agent is told to ask, not when it is seen asking.
 *
 * An over-count by one turn in the cases where it was told and did not,
 * which errs towards asking less. That is the right direction: the failure
 * this is guarding against is a customer being asked the same thing until
 * they stop replying.
 */
export async function recordAsked(
  run: QueryRunner,
  input: { operatorId: string; conversationId: string; fields: readonly EnquiryField[] },
): Promise<void> {
  if (input.fields.length === 0) return

  await run(
    `update conversations v
     set asked_for = (
       select coalesce(v.asked_for, '{}'::jsonb) || jsonb_object_agg(
         f.field,
         jsonb_build_object(
           'times', coalesce((v.asked_for -> f.field ->> 'times')::int, 0) + 1,
           'revision', v.revision
         )
       )
       from unnest($3::text[]) as f(field)
     )
     where v.id = $1 and v.operator_id = $2`,
    [input.conversationId, input.operatorId, input.fields as string[]],
  )
}

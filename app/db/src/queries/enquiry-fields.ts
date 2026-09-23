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

    /**
     * An end date and a duration are the same fact counted two ways, and only
     * one of them can be right.
     *
     * "From the 25th to the 27th" came in as start_at 25, end_at 27 **and**
     * duration "3 days" — all three from one sentence, nobody having said
     * three of anything. The quote calculator counts 2 rental days, saw a
     * stated 3, and refused with dates_disagree, which is correct: a price is
     * the one thing this system will not guess at. But that refusal was built
     * for a customer who changed their mind, and here the contradiction was
     * manufactured by the model in a single breath. The reply became "is that
     * 2 days or 3?", which no button could answer, and the conversation
     * stopped dead at the moment of sale.
     *
     * So the dates win. A duration is worth recording while the end is
     * unknown — "three days from Friday" is a real thing to say — and the
     * moment an end date exists it is a second copy of that fact with nothing
     * to add. `missingFields` has always treated them as alternatives; this
     * makes them alternatives in the record too.
     */
    const [live] = await tx(
      `select
         bool_or(field = 'end_at') as has_end,
         bool_or(field = 'duration') as has_duration
       from field_evidence
       where enquiry_id = $1 and operator_id = $2 and superseded_at is null`,
      [input.enquiryId, input.operatorId],
    )
    const endArriving = input.observations.some((o) => o.field === 'end_at')
    const endIsKnown = endArriving || live?.['has_end'] === true

    for (const observation of input.observations) {
      if (observation.field === 'duration' && endIsKnown) continue

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

    /**
     * And retire one that was already on file when the end date arrives, so a
     * duration recorded before the dates cannot outlive them.
     */
    if (endArriving && live?.['has_duration'] === true) {
      await tx(
        `update field_evidence
         set superseded_at = now()
         where enquiry_id = $1 and operator_id = $2 and field = 'duration'
           and superseded_at is null`,
        [input.enquiryId, input.operatorId],
      )
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

/**
 * The order somebody actually asks them in.
 *
 * REQUIRED_FOR_QUALIFICATION is section 3's list and is not an order — it says
 * which facts make an enquiry real, not which to ask for first. Built from it
 * directly, with `end_at` appended because it is the one alternative, the
 * sequence came out as car, start, delivery, end: "when does it start", then
 * "delivered or collected", then "and how long for". Nobody sells a car that
 * way, and the model did not either — told the enquiry needed a delivery
 * preference, it asked for the return date instead, which was the right
 * question and the wrong instruction.
 *
 * Dates together, then the thing that depends on them.
 */
const ASK_ORDER: readonly EnquiryField[] = [
  'vehicle', 'start_at', 'end_at', 'delivery_preference',
]

/** What is still missing before this enquiry could be called qualified. */
export async function missingFields(
  run: QueryRunner,
  operatorId: string,
  enquiryId: string,
): Promise<EnquiryField[]> {
  const present = new Set((await getEnquiryFields(run, operatorId, enquiryId)).map((f) => f.field))
  return ASK_ORDER.filter((field) =>
    // An end date or a duration satisfies the same requirement.
    field === 'end_at'
      ? !present.has('end_at') && !present.has('duration')
      : !present.has(field))
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
 * It returns the enquiry *under discussion*, which since `enquiryForVehicle`
 * is no longer the only live one. Ordered by `updated_at` rather than creation
 * so that a customer returning to the first of two bookings picks it back up:
 * recording against an enquiry touches it, so the one last written to is the
 * one last talked about. With a single enquiry the two orderings agree and
 * this is the behaviour it has always had.
 */
const NOT_YET_SPENT = `
  coalesce(
    (select max(fe.value::date) from field_evidence fe
      where fe.enquiry_id = e.id and fe.superseded_at is null
        and fe.field in ('start_at', 'end_at')
        -- Guard the cast: the column is text and only a resolved date is
        -- safe to compare.
        and fe.value ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
    current_date
  ) >= current_date`

export async function ensureEnquiry(
  run: QueryRunner,
  operatorId: string,
  conversationId: string,
): Promise<string | null> {
  const rows = await run(
    `with live as (
       select e.id from enquiries e
       where e.conversation_id = $2 and e.operator_id = $1
         and ${NOT_YET_SPENT}
       order by e.updated_at desc, e.created_at desc
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
 * Every rental this conversation is currently about.
 *
 * A conversation has been able to hold several enquiries since the schema was
 * written — "a Lamborghini for the weekend and a chauffeur car for the airport
 * run are two enquiries in one thread" — and nothing ever made a second one.
 * The cost was not theoretical. Asked for two bookings, the model put both car
 * names into the single `vehicle` slot as one string that matches no car in
 * the fleet, and wrote the second rental's dates into `special_requirements`,
 * where nothing prices them, checks them or reads them at all.
 *
 * Ordered oldest first, which is the order they were asked for and the order a
 * person would recount them in. `ensureEnquiry` picks the one being discussed;
 * this is all of them.
 */
export type Booking = {
  enquiryId: string
  /** The car, once one has been named. Null while it is still being chosen. */
  vehicle: string | null
  fields: EnquiryFieldValue[]
  updatedAt: Date
}

export async function liveEnquiries(
  run: QueryRunner,
  operatorId: string,
  conversationId: string,
): Promise<Booking[]> {
  const rows = await run(
    `select e.id, e.updated_at from enquiries e
     where e.conversation_id = $2 and e.operator_id = $1
       and ${NOT_YET_SPENT}
     order by e.created_at asc`,
    [operatorId, conversationId],
  )

  return Promise.all(rows.map(async (row) => {
    const enquiryId = row['id'] as string
    const fields = await getEnquiryFields(run, operatorId, enquiryId)
    return {
      enquiryId,
      vehicle: fields.find((f) => f.field === 'vehicle')?.value ?? null,
      fields,
      updatedAt: new Date(row['updated_at'] as string),
    }
  }))
}

/**
 * The booking for one named car, started if this conversation has none.
 *
 * The discriminator is the car rather than an opaque id, because the car is
 * what the customer actually says. "The Cullinan on Tuesday and the Lambo on
 * Sunday" names both; an id names neither, and handing the model ids to keep
 * straight is how it ends up quoting the wrong one.
 *
 * Deliberately not reached by a change of vehicle on its own. "Actually make
 * it the Ferrari" must still supersede, because that is a customer changing
 * their mind and splitting it would leave a phantom booking for a car they
 * turned down. Only an explicit `forVehicle` gets here — the judgement of
 * whether a second car is an addition or a correction is a reading of what
 * somebody meant, which is the model's to make and nothing else's.
 *
 * `vehicle` must already be canonical. The caller resolves it against the
 * fleet, so that "the Huracán" and "Lamborghini Huracán" find one booking
 * rather than opening two.
 */
export async function enquiryForVehicle(
  transact: Transactor,
  input: {
    operatorId: string
    conversationId: string
    vehicle: string
    sourceMessageId?: string | null
  },
): Promise<{ enquiryId: string; created: boolean }> {
  return transact(async (tx) => {
    const [existing] = await tx(
      `select e.id from enquiries e
       join field_evidence fe
         on fe.enquiry_id = e.id and fe.superseded_at is null
        and fe.field = 'vehicle' and lower(fe.value) = lower($3)
       where e.conversation_id = $2 and e.operator_id = $1
         and ${NOT_YET_SPENT}
       order by e.updated_at desc
       limit 1`,
      [input.operatorId, input.conversationId, input.vehicle],
    )
    if (existing !== undefined) {
      return { enquiryId: existing['id'] as string, created: false }
    }

    /**
     * An empty live enquiry is the one to adopt, not a second to sit beside.
     *
     * Every conversation opens one before the first reply, so the first car
     * named would otherwise always leave a blank enquiry behind it — and a
     * blank enquiry is a booking with nothing in it, which reads to everything
     * downstream as a rental whose car nobody has chosen yet.
     */
    const [blank] = await tx(
      `select e.id from enquiries e
       where e.conversation_id = $2 and e.operator_id = $1
         and ${NOT_YET_SPENT}
         and not exists (
           select 1 from field_evidence fe
           where fe.enquiry_id = e.id and fe.superseded_at is null
         )
       order by e.updated_at desc
       limit 1`,
      [input.operatorId, input.conversationId],
    )

    const enquiryId = blank !== undefined
      ? (blank['id'] as string)
      : ((await tx(
          `insert into enquiries (operator_id, conversation_id)
           select v.operator_id, v.id from conversations v
           where v.id = $2 and v.operator_id = $1
           returning id`,
          [input.operatorId, input.conversationId],
        ))[0]!['id'] as string)

    await tx(
      `insert into field_evidence
         (operator_id, enquiry_id, field, value, source_message_id, verification_state)
       values ($1, $2, 'vehicle', $3, $4, 'customer_stated')`,
      [input.operatorId, enquiryId, input.vehicle, input.sourceMessageId ?? null],
    )

    return { enquiryId, created: blank === undefined }
  })
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
  /** Which booking it belongs to. */
  enquiryId: string
  /**
   * The car it is about, when the booking has one.
   *
   * What makes the question askable at all once there are two. "How long do
   * you want it for?" has no answer when there is a Cullinan on Tuesday and a
   * Huracán on Sunday, and the customer has to guess which one is meant.
   */
  vehicle: string | null
}

/**
 * Counted per booking, not per field name.
 *
 * Keyed by field alone, the counter could not see the failure it was built
 * for. A conversation with a Cullinan and a Huracán in it asked "one day or
 * two?" four times in a hundred seconds while `asked_for` sat on a single
 * entry from seventy-eight revisions earlier — because the field it kept
 * asking about belonged to a booking that did not exist, so nothing counted
 * it, and the answer had nowhere to be written, so the next turn did not know
 * it had been given. A question that cannot be recorded is asked forever.
 *
 * Older entries are keyed by the bare field name and no longer match. They
 * simply stop applying, which errs towards asking once more rather than
 * falling silent, and `ASK_EVERY` still paces it.
 */
function askKey(enquiryId: string, field: EnquiryField): string {
  return `${enquiryId}:${field}`
}

export async function outstandingQuestions(
  run: QueryRunner,
  input: { operatorId: string; conversationId: string },
): Promise<OutstandingQuestion[]> {
  const bookings = await liveEnquiries(run, input.operatorId, input.conversationId)
  if (bookings.length === 0) return []

  const [row] = await run(
    `select revision, asked_for from conversations where id = $1 and operator_id = $2`,
    [input.conversationId, input.operatorId],
  )
  if (row === undefined) return []

  const revision = Number(row['revision'])
  const asked = (row['asked_for'] ?? {}) as Record<string, { times: number; revision: number }>

  /**
   * The booking under discussion first, so its questions are asked before a
   * second one's. Everything else keeps the order it was opened in.
   */
  const ordered = [...bookings].sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())

  /**
   * A rental that has been booked is asked about by its checklist, not here.
   *
   * Live: both ran at once. The checklist asked what time they would collect
   * while this still had "delivery or collection" outstanding for the same
   * rental, and its buttons went out under a question about paying.
   */
  const booked = new Set((await run(
    `select enquiry_id from bookings
     -- Confirmed only: a request still waiting on a person has no checklist
     -- yet, and what it is missing is still worth asking.
     where operator_id = $1 and conversation_id = $2 and state = 'confirmed'
       and enquiry_id is not null`,
    [input.operatorId, input.conversationId],
  )).map((r) => r['enquiry_id'] as string))

  const out: OutstandingQuestion[] = []
  for (const booking of ordered) {
    if (booked.has(booking.enquiryId)) continue
    const present = new Set(booking.fields.map((f) => f.field))
    const missing = ASK_ORDER.filter((field) =>
      field === 'end_at'
        ? !present.has('end_at') && !present.has('duration')
        : !present.has(field))

    for (const field of missing) {
      const record = asked[askKey(booking.enquiryId, field)]
      if (record !== undefined) {
        if (record.times >= ASK_AT_MOST) continue
        if (revision - record.revision < ASK_EVERY) continue
      }
      out.push({
        field,
        timesAsked: record?.times ?? 0,
        enquiryId: booking.enquiryId,
        vehicle: booking.vehicle,
      })
    }
  }
  return out
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
  input: {
    operatorId: string
    conversationId: string
    asked: ReadonlyArray<{ enquiryId: string; field: EnquiryField }>
  },
): Promise<void> {
  if (input.asked.length === 0) return
  const keys = input.asked.map((a) => askKey(a.enquiryId, a.field))

  await run(
    `update conversations v
     set asked_for = (
       select coalesce(v.asked_for, '{}'::jsonb) || jsonb_object_agg(
         f.key,
         jsonb_build_object(
           'times', coalesce((v.asked_for -> f.key ->> 'times')::int, 0) + 1,
           'revision', v.revision
         )
       )
       from unnest($3::text[]) as f(key)
     )
     where v.id = $1 and v.operator_id = $2`,
    [input.conversationId, input.operatorId, keys],
  )
}

/**
 * Every car this enquiry has been about, newest first.
 *
 * An enquiry holds one vehicle: `carChosenIn` picks it and anything else
 * supersedes. That is right for "which car is this rental for" and wrong for
 * "which cars are they weighing up", and the system had no way to say the
 * second — so a customer comparing a Cullinan against a Huracán looked
 * identical to one changing their mind twice.
 *
 * Derived rather than stored, like the sales stage. Every car they have
 * mentioned is already in `field_evidence` with the time they mentioned it;
 * what was missing was anything reading it as a set. No column, no migration,
 * and no second thing to keep in step with the first.
 *
 * Superseded rows included on purpose — that is the whole point. The live one
 * is still the live one and comes back first.
 */
export async function vehiclesConsidered(
  run: QueryRunner,
  operatorId: string,
  enquiryId: string,
): Promise<string[]> {
  const rows = await run(
    `select value, max(extracted_at) as last_mentioned
     from field_evidence
     where enquiry_id = $1 and operator_id = $2 and field = 'vehicle'
     group by value
     order by max(extracted_at) desc
     limit 6`,
    [enquiryId, operatorId],
  )
  return rows.map((r) => r['value'] as string)
}

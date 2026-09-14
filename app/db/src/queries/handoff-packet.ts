import { getEnquiryFields, missingFields, type EnquiryFieldValue } from './enquiry-fields.js'
import type { QueryRunner } from '../runner.js'

/**
 * Everything a salesperson needs to pick up a conversation cold.
 *
 * Section 8 of the MVP lists it: name and number, history, vehicle, dates,
 * location, budget, special requirements, what is known, what is still open,
 * why it came to them, how urgent, and what to do next.
 *
 * Assembled on demand rather than snapshotted at handoff time. A snapshot is
 * stale the moment the customer sends another message, and a salesperson
 * opening it twenty minutes later would read a transcript missing the last
 * thing said — while believing they had the full picture, which is worse than
 * knowing they do not.
 *
 * Every fact carries where it came from. "Ferrari 488" with no source is a
 * claim; with the customer's own words and the message that contained them it
 * is evidence, and a salesperson can tell the difference when the customer
 * disputes it.
 */

export type PacketFact = {
  field: string
  value: string
  /** What the customer actually typed, when it differed. */
  saidAs: string | null
  /** customer_stated, human_confirmed — never "the model thought so". */
  basis: string
  at: Date
}

export type HandoffPacket = {
  handoffId: string | null
  conversationId: string
  reason: string | null
  priority: string
  summary: string | null
  state: string | null
  dueAt: Date | null
  ownerMembershipId: string | null

  customer: { name: string | null; whatsappNumber: string; optedOut: boolean }

  /** What the customer has told us, with the evidence behind each item. */
  known: PacketFact[]
  /**
   * What is still missing before this is a complete enquiry.
   *
   * Section 3: their absence never blocks qualification, it is carried forward
   * as an open question. A salesperson who knows what is missing asks for it;
   * one who does not, guesses.
   */
  unresolved: string[]
  /** Anything the agent could not finish and left for a person. */
  waitingOnOperator: string | null

  transcript: Array<{ from: 'customer' | 'us'; text: string; at: Date }>
  notes: Array<{ body: string; at: Date }>
}

const CONTEXT_SQL = `
  select v.id, v.priority::text as priority, v.next_action, v.owner_membership_id,
         v.operator_id,
         c.display_name, c.channel_identifier, c.opted_out_at,
         e.id as enquiry_id,
         h.id as handoff_id, h.reason::text as reason, h.summary,
         h.state::text as state, h.due_at
  from conversations v
  join contacts c on c.id = v.contact_id and c.operator_id = v.operator_id
  left join lateral (
    select id from enquiries where conversation_id = v.id and operator_id = v.operator_id
    order by created_at limit 1
  ) e on true
  left join lateral (
    select id, reason, summary, state, due_at
    from handoffs
    where conversation_id = v.id and operator_id = v.operator_id
    order by created_at desc limit 1
  ) h on true
  where v.id = $1 and v.operator_id = $2
`

export async function assembleHandoffPacket(
  run: QueryRunner,
  operatorId: string,
  conversationId: string,
  options: { transcriptLimit?: number } = {},
): Promise<HandoffPacket | null> {
  const rows = await run(CONTEXT_SQL, [conversationId, operatorId])
  const row = rows[0]
  if (row === undefined) return null

  const enquiryId = (row['enquiry_id'] as string) ?? null

  const [fields, missing, transcript, notes] = await Promise.all([
    enquiryId === null
      ? Promise.resolve([] as EnquiryFieldValue[])
      : getEnquiryFields(run, operatorId, enquiryId),
    enquiryId === null ? Promise.resolve([]) : missingFields(run, operatorId, enquiryId),
    run(
      `select direction, body, created_at from messages
       where conversation_id = $1 and operator_id = $2
         and body is not null
         -- A cancelled draft was never seen by the customer, and showing it in
         -- a transcript would have a salesperson referring to something that
         -- was never said.
         and delivery_state not in ('cancelled', 'failed')
       order by created_at desc limit $3`,
      [conversationId, operatorId, options.transcriptLimit ?? 40],
    ),
    run(
      `select body, created_at from conversation_notes
       where conversation_id = $1 and operator_id = $2 order by created_at`,
      [conversationId, operatorId],
    ),
  ])

  return {
    handoffId: (row['handoff_id'] as string) ?? null,
    conversationId,
    reason: (row['reason'] as string) ?? null,
    priority: row['priority'] as string,
    summary: (row['summary'] as string) ?? null,
    state: (row['state'] as string) ?? null,
    dueAt: row['due_at'] == null ? null : new Date(row['due_at'] as string),
    ownerMembershipId: (row['owner_membership_id'] as string) ?? null,

    customer: {
      name: (row['display_name'] as string) ?? null,
      whatsappNumber: row['channel_identifier'] as string,
      optedOut: row['opted_out_at'] != null,
    },

    known: fields.map((f) => ({
      field: f.field,
      value: f.value,
      saidAs: f.originalWording,
      basis: f.verificationState,
      at: f.extractedAt,
    })),
    unresolved: missing,
    waitingOnOperator: (row['next_action'] as string) ?? null,

    // Reversed: the query takes the newest for the limit, a person reads a
    // conversation forwards.
    transcript: transcript.reverse().map((m) => ({
      from: m['direction'] === 'inbound' ? ('customer' as const) : ('us' as const),
      text: m['body'] as string,
      at: new Date(m['created_at'] as string),
    })),
    notes: notes.map((n) => ({
      body: n['body'] as string,
      at: new Date(n['created_at'] as string),
    })),
  }
}

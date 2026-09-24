import {
  canonicalVehicleName, enquiryForVehicle, recordFields, type FieldObservation,
} from '@vyra/db'
import { civilDateIn, formatCivil } from '@vyra/contracts'
import type { ToolContext } from './context.js'
import { ok, refuse, type ToolResult } from './result.js'
import type { recordEnquiryFieldsSchema } from './schemas.js'
import type { z } from 'zod'

export type RecordedFields = {
  recorded: Array<{ field: string; value: string }>
  /**
   * Which booking these landed on.
   *
   * Returned because the model needs it to quote: `prepare_quote` takes an
   * enquiry id, and with two rentals in one thread the id it was given at the
   * top of the turn is only one of them.
   */
  enquiryId: string
  /** True when this call opened a second rental alongside an existing one. */
  startedNewBooking?: boolean
  /**
   * Fields where this contradicts something the customer said earlier.
   *
   * Returned separately, and named so it is hard to ignore, because section 15
   * requires the contradiction to be summarised and asked about rather than
   * resolved silently. Both values are still in `field_evidence`; this is the
   * model's prompt to raise it.
   */
  conflicts: Array<{ field: string; previousValue: string; newValue: string }>
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}/
const DATE_FIELDS = new Set(['start_at', 'end_at'])

/**
 * Mandatory check (section 18.8): evidence, and explicit conflict handling.
 *
 * Evidence is not an argument. `sourceMessageId` is taken from `ctx` — the
 * inbound message this turn is answering — so the model cannot attribute a fact
 * to a message that did not contain it. Section 7 requires every extracted
 * value to carry its source message, extraction time and verification state,
 * and an attribution the model chose would be worth nothing as evidence.
 *
 * `verificationState` is fixed at `customer_stated` for the same reason. A
 * model has no means of verifying anything; it heard someone say it. Moving a
 * fact to `system_verified` or `human_confirmed` requires a system or a human,
 * and neither is in this call path.
 *
 * Conflict handling is explicit rather than automatic. `recordFields`
 * supersedes instead of overwriting, so the earlier value survives, and this
 * hands the conflicts back so the reply can ask which is right. Re-stating the
 * same value is not a conflict: a customer repeating "Friday" should not look
 * like they changed their mind.
 *
 * Dates are re-checked here even though step 22 normalises them, because this
 * is the write. A malformed date that reaches `field_evidence` becomes a fact
 * that later steps trust.
 */
export async function recordEnquiryFields(
  ctx: ToolContext,
  args: z.infer<typeof recordEnquiryFieldsSchema>,
): Promise<ToolResult<RecordedFields>> {
  const today = formatCivil(civilDateIn(ctx.now, ctx.timezone))

  for (const field of args.fields) {
    if (!DATE_FIELDS.has(field.field)) continue
    /**
     * A date, and only a date. Live: "11 AM at the airport" was recorded as
     * start_at "2026-09-26 11:00"; the prefix check let it through, and the
     * next quote asked the database for "2026-09-26 11:00T00:00:00Z", which
     * crashed the turn — "AI unavailable" at the moment the customer said
     * "confirm this booking". The time is the handover's, asked for after
     * booking; here it is dropped.
     */
    const withTime = field.value.match(/^(\d{4}-\d{2}-\d{2})[ T]\d{1,2}:\d{2}(?::\d{2})?\S*$/)
    if (withTime !== null) (field as { value: string }).value = withTime[1]!
    if (!/^\d{4}-\d{2}-\d{2}$/.test(field.value)) {
      return refuse(
        'invalid_arguments',
        `"${field.value}" is not a resolved date for ${field.field}. Resolve it against today (${today}) and confirm it with the customer before recording it.`,
      )
    }
  }

  /**
   * A car goes in under one name, whichever name it arrived as.
   *
   * The model writes what it understood — "Ferrari 488", "the Huracán", "Rolls
   * Royce" — and the turn's own auto-record writes `make model`. Left alone
   * those are different strings for one car, each superseding the other, and
   * an enquiry that looks like a customer changing their mind about something
   * they never stopped talking about.
   *
   * The customer's own words are kept in `originalWording` either way, which
   * is where the evidence lives. This only settles what the value is.
   */
  const observations: FieldObservation[] = await Promise.all(args.fields.map(async (f) => {
    const canonical = f.field !== 'vehicle'
      ? null
      : await canonicalVehicleName(ctx.run, ctx.operatorId, f.value).catch(() => null)

    return {
      field: f.field,
      value: canonical ?? f.value,
      // What they actually said, preferred over what the model resolved it to.
      originalWording: f.originalWording ?? (canonical === null ? null : f.value),
      sourceMessageId: ctx.messageId,
      verificationState: 'customer_stated' as const,
    }
  }))

  /**
   * Which rental this is about.
   *
   * `ctx.enquiryId` is the one under discussion, which is right for every call
   * that does not name a car — including a change of mind, where superseding
   * on the current enquiry is exactly what should happen. A named car means a
   * second rental running alongside, and it gets its own enquiry so that it
   * has its own dates, its own availability and its own price. Both cars in
   * one `vehicle` field is a value matching no car in the fleet, which is what
   * the record showed before this existed.
   */
  let enquiryId = ctx.enquiryId
  let startedNewBooking = false
  if (args.forVehicle !== null && args.forVehicle.trim() !== '') {
    const named = await canonicalVehicleName(ctx.run, ctx.operatorId, args.forVehicle)
      .catch(() => null) ?? args.forVehicle
    const booking = await enquiryForVehicle(ctx.transact, {
      operatorId: ctx.operatorId,
      conversationId: ctx.conversationId,
      vehicle: named,
      sourceMessageId: ctx.messageId,
    })
    enquiryId = booking.enquiryId
    startedNewBooking = booking.created
  }

  const recorded = await recordFields(ctx.transact, {
    operatorId: ctx.operatorId,
    enquiryId,
    observations,
  })

  if (recorded.length === 0) {
    return refuse('nothing_to_do', 'None of those values could be recorded.')
  }

  return ok({
    enquiryId,
    ...(startedNewBooking ? { startedNewBooking: true } : {}),
    recorded: recorded.map((r) => ({ field: r.field, value: r.value })),
    conflicts: recorded
      .filter((r) => r.corrected && r.previousValue !== null)
      .map((r) => ({ field: r.field, previousValue: r.previousValue as string, newValue: r.value })),
  })
}

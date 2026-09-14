import { civilDateIn, formatCivil } from '@vyra/contracts'
import type { ToolContext } from './context.js'
import { refuse, type ToolResult } from './result.js'
import type { searchVehiclesSchema } from './schemas.js'
import type { z } from 'zod'

export type VehicleCandidate = {
  vehicleId: string
  name: string
  available: boolean
  /** When a person last verified this, per section 9. Never omitted. */
  checkedAt: string
  checkedBy: string
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/**
 * Mandatory check (section 18.8): validated dates and a trusted inventory source.
 *
 * Both checks run. The first is implemented; the second currently refuses.
 *
 * Dates are validated here rather than trusted from the model because a model
 * that has mis-resolved "next Friday" will produce a well-formed date that is
 * simply wrong, and a strict schema cannot tell the difference — section 18.8
 * says as much. Shape, ordering and a past start date are all checked.
 *
 * The inventory source does not exist yet. Vehicle records, rates and the
 * person who last checked them arrive with the Operations console in build plan
 * step 30, and section 9 is explicit that an availability answer must carry the
 * time it was checked and who checked it.
 *
 * So this refuses. That is the correct behaviour rather than a stub: an
 * availability answer with no verified source is exactly the confident wrong
 * answer the boundary exists to stop, and the failure mode of inventing one is
 * a customer being promised a car that is already out. The refusal names the
 * reason so the model says "let me check with the team" and hands over, which
 * is what a salesperson would do with the same information.
 */
export async function searchVehicles(
  ctx: ToolContext,
  args: z.infer<typeof searchVehiclesSchema>,
): Promise<ToolResult<VehicleCandidate[]>> {
  const today = formatCivil(civilDateIn(ctx.now, ctx.timezone))

  for (const [label, value] of [['start', args.startDate], ['end', args.endDate]] as const) {
    if (value === null) continue
    if (!ISO_DATE.test(value) || Number.isNaN(Date.parse(value))) {
      return refuse('invalid_arguments', `The ${label} date "${value}" is not a real YYYY-MM-DD date.`)
    }
  }

  if (args.startDate !== null && args.startDate < today) {
    return refuse(
      'invalid_arguments',
      `The start date ${args.startDate} is in the past — today is ${today} for this operator. Ask the customer which date they meant.`,
    )
  }

  if (args.startDate !== null && args.endDate !== null && args.endDate < args.startDate) {
    return refuse(
      'invalid_arguments',
      `The end date ${args.endDate} is before the start date ${args.startDate}. Ask the customer to confirm the dates.`,
    )
  }

  if (args.startDate === null) {
    return refuse(
      'invalid_arguments',
      'Availability needs a start date. Ask the customer when they want the car before checking.',
    )
  }

  return refuse(
    'no_trusted_source',
    'There is no verified availability source connected yet, so availability cannot be confirmed. Tell the customer you are checking with the team and hand over — do not state that anything is available.',
  )
}

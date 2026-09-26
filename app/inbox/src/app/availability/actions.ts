'use server'

import { revalidatePath } from 'next/cache'
import {
  CAR_STATUSES, recordUnavailable, releaseAvailability, setCalendarComplete, setCarStatus,
  type CarStatus,
} from '@vyra/db'
import { assertPermitted, permissions, requireActor } from '@/lib/auth'
import { actorRunner } from '@/lib/db'

export type BlockState = { error: string | null }

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

export async function markUnavailable(
  _previous: BlockState,
  formData: FormData,
): Promise<BlockState> {
  const actor = await requireActor()
  assertPermitted(permissions.canReply(actor), 'record a booking')

  const vehicleId = String(formData.get('vehicleId') ?? '')
  const startDate = String(formData.get('startDate') ?? '')
  const endDate = String(formData.get('endDate') ?? '') || startDate
  const reason = String(formData.get('reason') ?? 'booked')
  const note = String(formData.get('note') ?? '').trim()

  if (!ISO_DATE.test(startDate)) return { error: 'Pick a start date.' }
  if (!ISO_DATE.test(endDate)) return { error: 'Pick an end date.' }
  if (endDate < startDate) return { error: 'The end date is before the start date.' }

  await recordUnavailable(actorRunner(actor), {
    operatorId: actor.operatorId,
    vehicleId,
    startDate,
    endDate,
    reason,
    note: note === '' ? null : note,
    // The name, not the id: this is read by whoever wonders why a customer was
    // told no, and an id tells them nothing.
    recordedBy: actor.email ?? actor.role,
    recordedByMembershipId: actor.membershipId,
  })

  revalidatePath('/availability')
  return { error: null }
}

export type StatusState = { error: string | null; warning: string | null }

/**
 * A car in service, in the garage, damaged or off sale — or back on the road.
 *
 * Its bookings are left where they are: the car cannot be driven whatever the
 * calendar says, but a customer's booking is not somebody else's to cancel,
 * and the warning is what tells the team to pick up the phone.
 */
export async function setStatus(
  _previous: StatusState,
  formData: FormData,
): Promise<StatusState> {
  const actor = await requireActor()
  assertPermitted(permissions.canReply(actor), 'change a car\'s status')

  const status = String(formData.get('status') ?? '')
  const backOn = String(formData.get('backOn') ?? '')
  const note = String(formData.get('note') ?? '').trim()

  if (status !== 'available' && !(status in CAR_STATUSES)) {
    return { error: 'Pick a status.', warning: null }
  }
  if (backOn !== '' && !ISO_DATE.test(backOn)) return { error: 'Pick the day it is back.', warning: null }

  const result = await setCarStatus(actorRunner(actor), {
    operatorId: actor.operatorId,
    vehicleId: String(formData.get('vehicleId') ?? ''),
    status: status as CarStatus | 'available',
    backOn: backOn === '' ? null : backOn,
    note: note === '' ? null : note,
    recordedBy: actor.email ?? actor.role,
    recordedByMembershipId: actor.membershipId,
  })
  if (!result.ok) return { error: result.detail, warning: null }

  revalidatePath('/availability')
  return {
    error: null,
    warning: result.clashingBookings === 0
      ? null
      : `${result.clashingBookings === 1 ? 'A customer has' : `${result.clashingBookings} customers have`} `
        + 'this car booked while it is off the road. The booking still stands — call them.',
  }
}

export async function releaseBlock(formData: FormData): Promise<void> {
  const actor = await requireActor()
  assertPermitted(permissions.canReply(actor), 'release a booking')

  await releaseAvailability(actorRunner(actor), {
    operatorId: actor.operatorId,
    id: String(formData.get('blockId') ?? ''),
    releasedBy: actor.email ?? actor.role,
  })
  revalidatePath('/availability')
}

/**
 * The operator claiming their calendar is current.
 *
 * Deliberately a person's decision and an administrator's: it converts an empty
 * calendar from "nobody recorded anything" into "this car is free", and the
 * agent will say so to customers. Nothing should infer it.
 */
export async function setCalendarIsComplete(formData: FormData): Promise<void> {
  const actor = await requireActor()
  assertPermitted(permissions.canAdminister(actor), 'change how the calendar is read')

  await setCalendarComplete(actorRunner(actor), {
    operatorId: actor.operatorId,
    complete: String(formData.get('complete')) === 'true',
    membershipId: actor.membershipId,
  })
  revalidatePath('/availability')
}

'use server'

import { revalidatePath } from 'next/cache'
import { recordUnavailable, releaseAvailability, setCalendarComplete } from '@vyra/db'
import { assertPermitted, permissions, requireActor } from '@/lib/auth'
import { queryRunner } from '@/lib/db'

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

  await recordUnavailable(queryRunner(), {
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

export async function releaseBlock(formData: FormData): Promise<void> {
  const actor = await requireActor()
  assertPermitted(permissions.canReply(actor), 'release a booking')

  await releaseAvailability(queryRunner(), {
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

  await setCalendarComplete(queryRunner(), {
    operatorId: actor.operatorId,
    complete: String(formData.get('complete')) === 'true',
    membershipId: actor.membershipId,
  })
  revalidatePath('/availability')
}

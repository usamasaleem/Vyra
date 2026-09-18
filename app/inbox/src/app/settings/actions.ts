'use server'

import { revalidatePath } from 'next/cache'
import { isOperatorTimezone } from '@vyra/contracts'
import { checkSettings, updateOperatorSettings, type SettingsProblem } from '@vyra/db'
import { assertPermitted, permissions, requireActor } from '@/lib/auth'
import { actorRunner } from '@/lib/db'

export type SettingsState = { problems: SettingsProblem[]; saved: boolean }

/**
 * A blank field is "switched off" only where off is a real answer.
 *
 * Everywhere else a blank is somebody clearing a box to retype it and
 * submitting by accident, and turning that into zero would chase a customer
 * in the same second they stopped typing.
 */
function minutes(formData: FormData, field: string): number | null {
  const raw = String(formData.get(field) ?? '').trim()
  if (raw === '') return null
  const value = Number(raw)
  return Number.isFinite(value) ? Math.round(value) : Number.NaN
}

export async function saveSettings(
  _previous: SettingsState,
  formData: FormData,
): Promise<SettingsState> {
  const actor = await requireActor()
  assertPermitted(permissions.canAdminister(actor), 'change the operator settings')

  const timezone = String(formData.get('timezone') ?? '')
  if (!isOperatorTimezone(timezone)) {
    return { problems: [{ field: 'timezone', message: 'Choose a timezone from the list.' }], saved: false }
  }

  const owner = String(formData.get('fallbackOwnerMembershipId') ?? '').trim()

  const website = String(formData.get('websiteUrl') ?? '').trim()

  const update = {
    name: String(formData.get('name') ?? ''),
    timezone,
    websiteUrl: website === '' ? null : website,
    // The one setting where blank means off: an operator can decide a person
    // handles it however long that takes.
    aiResumesAfterMinutes: minutes(formData, 'aiResumesAfterMinutes'),
    followUpAfterMinutes: minutes(formData, 'followUpAfterMinutes') ?? Number.NaN,
    handoffSlaMinutes: minutes(formData, 'handoffSlaMinutes') ?? Number.NaN,
    answerValidMinutes: minutes(formData, 'answerValidMinutes') ?? Number.NaN,
    retentionDays: minutes(formData, 'retentionDays') ?? Number.NaN,
    fallbackOwnerMembershipId: owner === '' ? null : owner,
    /**
     * The one switch here that changes what the software may promise for
     * somebody. A ceiling in whole currency on the form, stored in minor
     * units like every other amount; blank means no ceiling.
     */
    autoConfirmBookings: formData.get('autoConfirmBookings') === 'on',
    autoConfirmLimitMinor: (() => {
      const raw = String(formData.get('autoConfirmLimit') ?? '').trim()
      if (raw === '') return null
      const major = Number(raw)
      return Number.isFinite(major) && major > 0 ? Math.round(major * 100) : null
    })(),
  }

  const problems = checkSettings(update)
  if (problems.length > 0) return { problems, saved: false }

  await updateOperatorSettings(actorRunner(actor), {
    ...update,
    operatorId: actor.operatorId,
    actorMembershipId: actor.membershipId,
  })

  revalidatePath('/settings')
  return { problems: [], saved: true }
}

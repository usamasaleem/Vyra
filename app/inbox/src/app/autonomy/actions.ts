'use server'

import { revalidatePath } from 'next/cache'
import { setAutoCheckDocuments, setAutonomous } from '@vyra/db'
import { assertPermitted, permissions, requireActor } from '@/lib/auth'
import { actorRunner } from '@/lib/db'

export type AutonomyResult = { missing: string[] } | null

/** Administrators only: this decides what the agent may promise with nobody watching. */
export async function switchAutonomy(_previous: AutonomyResult, formData: FormData): Promise<AutonomyResult> {
  const actor = await requireActor()
  assertPermitted(permissions.canAdminister(actor), 'switch the agent to autonomous')
  const on = String(formData.get('on') ?? '') === 'true'
  const result = await setAutonomous(actorRunner(actor), {
    operatorId: actor.operatorId, membershipId: actor.membershipId, on,
  })
  revalidatePath('/autonomy')
  return result.ok ? null : { missing: result.missing }
}

export async function switchDocumentChecks(formData: FormData): Promise<void> {
  const actor = await requireActor()
  assertPermitted(permissions.canAdminister(actor), 'change how documents are checked')
  await setAutoCheckDocuments(actorRunner(actor), {
    operatorId: actor.operatorId, on: String(formData.get('on') ?? '') === 'true',
  })
  revalidatePath('/autonomy')
}

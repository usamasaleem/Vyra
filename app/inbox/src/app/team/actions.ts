'use server'

import { revalidatePath } from 'next/cache'
import { isMembershipRole } from '@vyra/contracts'
import { inviteMember, revokeInvitation, setMemberActive, setMemberRole } from '@vyra/db'
import { assertPermitted, permissions, requireActor } from '@/lib/auth'
import { actorRunner } from '@/lib/db'

/**
 * Who may change the team: administrators, and nobody else.
 *
 * Checked here rather than only in the page, because hiding a button is a
 * courtesy and refusing the action is the control. A manager who finds this
 * form is refused by the same line as a salesperson who guesses the URL.
 */
export async function invite(_previous: { error: string | null }, formData: FormData) {
  const actor = await requireActor()
  assertPermitted(permissions.canAdminister(actor), 'invite a colleague')

  const email = String(formData.get('email') ?? '').trim()
  const role = String(formData.get('role') ?? '')

  if (email === '' || !email.includes('@')) return { error: 'Enter their email address.' }
  if (!isMembershipRole(role)) return { error: 'Choose a role.' }

  await inviteMember(actorRunner(actor), {
    operatorId: actor.operatorId,
    email,
    role,
    invitedByMembershipId: actor.membershipId,
  })

  revalidatePath('/team')
  return { error: null }
}

export async function withdrawInvitation(formData: FormData): Promise<void> {
  const actor = await requireActor()
  assertPermitted(permissions.canAdminister(actor), 'withdraw an invitation')

  await revokeInvitation(actorRunner(actor), {
    operatorId: actor.operatorId,
    invitationId: String(formData.get('invitationId') ?? ''),
  })
  revalidatePath('/team')
}

export async function changeRole(formData: FormData): Promise<void> {
  const actor = await requireActor()
  assertPermitted(permissions.canAdminister(actor), 'change a role')

  await setMemberRole(actorRunner(actor), {
    operatorId: actor.operatorId,
    membershipId: String(formData.get('membershipId') ?? ''),
    role: String(formData.get('role') ?? ''),
  })
  revalidatePath('/team')
}

/**
 * Switching somebody off rather than deleting them.
 *
 * Their name stays on the conversations they handled and the notes they wrote,
 * which is the point: a salesperson who leaves does not take the history of
 * who said what to which customer with them.
 */
export async function setActive(formData: FormData): Promise<void> {
  const actor = await requireActor()
  assertPermitted(permissions.canAdminister(actor), 'change who has access')

  await setMemberActive(actorRunner(actor), {
    operatorId: actor.operatorId,
    membershipId: String(formData.get('membershipId') ?? ''),
    active: formData.get('active') === 'true',
  })
  revalidatePath('/team')
}

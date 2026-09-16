'use server'

import { redirect } from 'next/navigation'
import { acceptInvitation, createOperatorWithAdmin, findPendingInvitation } from '@vyra/db'
import { createSupabaseServerClient } from '@/lib/supabase/server'
import { queryRunner, transactor } from '@/lib/db'
import { isOperatorTimezone } from '@vyra/contracts'

export type FinishState = { error: string | null }

/**
 * The second half of signing up, for anybody who did not get to do it in one go.
 *
 * Same two branches as the sign-up action and the same rule about where the
 * answer comes from: the invitation is looked up by the address Supabase
 * verified, never by anything the form said. A form that could name its own
 * company would be a way into somebody else's.
 */
export async function finishSetup(
  _previous: FinishState,
  formData: FormData,
): Promise<FinishState> {
  const supabase = await createSupabaseServerClient()
  const { data } = await supabase.auth.getUser()
  const user = data.user
  if (user === null || user.email === undefined) redirect('/login')

  const invitation = await findPendingInvitation(queryRunner(), user.email)

  if (invitation !== null) {
    const joined = await acceptInvitation(transactor(), {
      invitationId: invitation.id, userId: user.id,
    })
    if (!joined.accepted) {
      // Revoked, or claimed in another tab between the page rendering and this
      // submission. Reloading shows them what is actually true now.
      return { error: 'That invitation is no longer open. Ask your colleague to send another.' }
    }
    console.log(JSON.stringify({
      event: 'auth.joined_by_invitation', email: user.email, operator: joined.operatorId,
    }))
    redirect('/')
  }

  const company = String(formData.get('company') ?? '').trim()
  const timezone = String(formData.get('timezone') ?? 'Asia/Dubai')

  if (company === '') return { error: 'Enter your company name.' }
  if (!isOperatorTimezone(timezone)) {
    return { error: 'Choose a timezone from the list.' }
  }

  const created = await createOperatorWithAdmin(transactor(), {
    name: company, timezone, userId: user.id,
  })
  console.log(JSON.stringify({
    event: 'operator.created', email: user.email, operator: created.operatorId, timezone,
  }))

  redirect('/')
}

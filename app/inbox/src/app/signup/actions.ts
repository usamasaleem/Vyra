'use server'

import { redirect } from 'next/navigation'
import { isOperatorTimezone } from '@vyra/contracts'
import {
  acceptInvitation, createOperatorWithAdmin, findPendingInvitation,
} from '@vyra/db'
import { createSupabaseServerClient } from '@/lib/supabase/server'
import { queryRunner, transactor } from '@/lib/db'

/**
 * Build plan step 36 — signing up without somebody in the database.
 *
 * Two paths through one form, decided by whether an administrator has already
 * asked for this address:
 *
 *   invited     join that operator, at the role they chose
 *   not invited create a new operator and become its administrator
 *
 * The distinction is made after authentication and from the address Supabase
 * verified, never from anything the form said. Otherwise "which company am I
 * joining" would be a question the browser gets to answer.
 *
 * Privileged, and this is the one place in the application where that is not a
 * mistake: row-level security is written in terms of the operators a user
 * belongs to, and at this moment they belong to none. Every policy would
 * correctly refuse the very insert that gives them one.
 */

export type SignUpState = { error: string | null }

export async function signUp(
  _previous: SignUpState,
  formData: FormData,
): Promise<SignUpState> {
  const email = String(formData.get('email') ?? '').trim()
  const password = String(formData.get('password') ?? '')
  const company = String(formData.get('company') ?? '').trim()
  const timezone = String(formData.get('timezone') ?? 'Asia/Dubai')

  if (email === '' || password === '') return { error: 'Enter your email and a password.' }
  if (password.length < 10) {
    // Supabase enforces its own minimum; this one is ours and is higher,
    // because these accounts read every customer conversation an operator has.
    return { error: 'Use a password of at least 10 characters.' }
  }
  if (!isOperatorTimezone(timezone)) {
    return { error: 'Choose a timezone from the list.' }
  }

  const supabase = await createSupabaseServerClient()
  const { data, error } = await supabase.auth.signUp({ email, password })

  if (error !== null) {
    console.log(JSON.stringify({
      event: 'auth.sign_up_failed', email, code: error.code ?? null, reason: error.message,
    }))
    /**
     * Deliberately the same answer whether the address is taken or the
     * password was refused. A different message for each turns this form into
     * a way to ask whether somebody has an account here.
     */
    return { error: 'Could not create that account. Try signing in instead.' }
  }

  const userId = data.user?.id
  if (userId === undefined) {
    return { error: 'Could not create that account. Try again in a moment.' }
  }

  /**
   * No session means the project requires email confirmation. The account
   * exists; the operator cannot be created until they come back signed in, and
   * telling them to check their email is the only honest thing to say.
   */
  if (data.session === null) {
    console.log(JSON.stringify({ event: 'auth.sign_up_needs_confirmation', email }))
    redirect('/signup/check-your-email')
  }

  const run = queryRunner()
  const invitation = await findPendingInvitation(run, email)

  if (invitation !== null) {
    const joined = await acceptInvitation(transactor(), { invitationId: invitation.id, userId })
    console.log(JSON.stringify({
      event: 'auth.joined_by_invitation',
      email, operator: joined.operatorId, accepted: joined.accepted,
    }))
    redirect('/')
  }

  if (company === '') {
    return { error: 'Enter your company name.' }
  }

  const created = await createOperatorWithAdmin(transactor(), {
    name: company, timezone, userId,
  })
  console.log(JSON.stringify({
    event: 'operator.created', email, operator: created.operatorId, timezone,
  }))

  redirect('/')
}

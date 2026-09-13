'use server'

import { redirect } from 'next/navigation'
import { createSupabaseServerClient } from '@/lib/supabase/server'

/**
 * There is no sign-up here on purpose.
 *
 * This is an internal tool. Accounts are provisioned by an administrator, and
 * a self-serve sign-up route would let anyone create a login — which grants no
 * data access on its own, but is not something an operator's sales inbox
 * should offer to the public.
 */
export async function signIn(
  _previous: { error: string | null },
  formData: FormData,
): Promise<{ error: string | null }> {
  const email = String(formData.get('email') ?? '').trim()
  const password = String(formData.get('password') ?? '')

  if (email === '' || password === '') {
    return { error: 'Enter your email and password.' }
  }

  const supabase = await createSupabaseServerClient()
  const { error } = await supabase.auth.signInWithPassword({ email, password })

  if (error !== null) {
    /**
     * Vague to the browser, specific to the log.
     *
     * Distinguishing "no such account" from "wrong password" in the response
     * tells an attacker which emails are real. But an operator whose staff
     * cannot sign in needs a real answer, and a message that hides the cause
     * from us as well as from an attacker is just a message nobody can act on.
     */
    console.log(
      JSON.stringify({
        event: 'auth.sign_in_failed',
        email,
        code: error.code ?? null,
        status: error.status ?? null,
        reason: error.message,
      }),
    )
    return { error: 'That email and password did not match.' }
  }

  console.log(JSON.stringify({ event: 'auth.sign_in_succeeded', email }))

  redirect('/')
}

export async function signOut(): Promise<void> {
  const supabase = await createSupabaseServerClient()
  await supabase.auth.signOut()
  redirect('/login')
}

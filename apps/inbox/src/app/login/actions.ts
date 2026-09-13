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
    // Deliberately vague: distinguishing "no such account" from "wrong
    // password" tells an attacker which emails are real.
    return { error: 'That email and password did not match.' }
  }

  redirect('/')
}

export async function signOut(): Promise<void> {
  const supabase = await createSupabaseServerClient()
  await supabase.auth.signOut()
  redirect('/login')
}

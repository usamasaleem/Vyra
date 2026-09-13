import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { serverEnv } from '../env'

/**
 * A fresh client per request. Never share one across requests — it carries the
 * caller's session, and a shared client would hand one user another's.
 */
export async function createSupabaseServerClient() {
  const cookieStore = await cookies()
  const env = serverEnv()

  return createServerClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (cookiesToSet) => {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options)
          }
        } catch {
          // Server Components cannot set cookies. The middleware refreshes the
          // session instead, which is why it must exist.
        }
      },
    },
  })
}

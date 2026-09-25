import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'
import { serverEnv } from '../env'

/**
 * Refreshes the session on every request and writes the rotated tokens back.
 *
 * Supabase's own documentation is blunt about this: failing to implement both
 * getAll and setAll correctly causes random logouts and hard-to-debug auth
 * failures. Server Components cannot set cookies, so if this does not run, a
 * refreshed token is computed and then thrown away on every request.
 */
export async function updateSession(request: NextRequest): Promise<NextResponse> {
  let response = NextResponse.next({ request })
  const env = serverEnv()

  const supabase = createServerClient(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (cookiesToSet) => {
          for (const { name, value } of cookiesToSet) {
            request.cookies.set(name, value)
          }
          response = NextResponse.next({ request })
          for (const { name, value, options } of cookiesToSet) {
            response.cookies.set(name, value, options)
          }
        },
      },
    },
  )

  // Must happen before the response is generated, or the refresh is lost.
  const { data } = await supabase.auth.getUser()

  const path = request.nextUrl.pathname
  // The webhook never reaches here — it is excluded at the matcher, so no edge
  // hop can disturb the bytes its signature is computed over.
  // Sign-up is public for the same reason sign-in is: there is nobody to
  // authenticate yet. It grants no access to anybody's data on its own — a new
  // account is a member of nothing until it creates a company or accepts an
  // invitation, and both of those happen after Supabase has verified who it is.
  // '/paid' is where Stripe sends a customer after paying: they have no account here.
  const isPublic = path === '/login' || path === '/signup' || path.startsWith('/signup/') || path === '/paid'

  if (data.user === null && !isPublic) {
    /**
     * Redirecting a fetch to an HTML login page gives the caller a 200 full of
     * markup, which a polling client cannot distinguish from real data. API
     * routes get a status code they can act on instead.
     */
    if (path.startsWith('/api/')) {
      return NextResponse.json({ error: 'not signed in' }, { status: 401 })
    }
    const url = request.nextUrl.clone()
    url.pathname = '/login'
    url.searchParams.set('next', path)
    return NextResponse.redirect(url)
  }

  if (data.user !== null && path === '/login') {
    const url = request.nextUrl.clone()
    url.pathname = '/'
    url.search = ''
    return NextResponse.redirect(url)
  }

  return response
}

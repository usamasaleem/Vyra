import type { NextRequest } from 'next/server'
import { updateSession } from '@/lib/supabase/middleware'

export async function middleware(request: NextRequest) {
  return await updateSession(request)
}

export const config = {
  matcher: [
    /**
     * Everything except static assets.
     *
     * The Meta webhook is matched too, and is allowed through unauthenticated
     * inside updateSession — it authenticates by HMAC signature, not by
     * session, and redirecting it to a login page would silently break intake.
     */
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}

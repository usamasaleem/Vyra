import type { NextRequest } from 'next/server'
import { updateSession } from '@/lib/supabase/middleware'

export async function middleware(request: NextRequest) {
  return await updateSession(request)
}

export const config = {
  matcher: [
    /**
     * Everything except static assets AND the Meta webhook.
     *
     * The webhook is excluded at the matcher rather than waved through inside
     * updateSession, because on Netlify the middleware is deployed as an edge
     * function and the request is then forwarded to the server function. That
     * hop can re-encode the body, and the signature is an HMAC over the exact
     * bytes Meta sent — so a request that merely passes through the middleware
     * arrives with a body that no longer matches its signature. Verified: the
     * same signed payload was accepted locally and rejected once deployed.
     *
     * It costs nothing to exclude. The webhook authenticates by signature and
     * has no session to refresh.
     */
    '/((?!api/webhooks|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}

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
     * The webhook authenticates by HMAC signature and has no session to
     * refresh, so running session middleware on it does nothing but add a hop.
     * On Netlify that hop is a separate edge function, so excluding the path
     * also keeps the request that carries a byte-exact signature on the
     * shortest route to the handler.
     *
     * api/fleet-photo is excluded for a blunter reason: WhatsApp fetches it and
     * cannot sign in. It is a composite of photographs the operator publishes
     * of cars they advertise, behind an unguessable id, and it composes only
     * URLs already stored on that vehicle rather than anything a caller names.
     *
     * Note for anyone reading the history: this exclusion was originally made
     * to fix a signature failure on Netlify. That failure turned out to be a
     * broken test command, not a platform problem — the deployed webhook was
     * verifying signatures correctly the whole time. The change is kept
     * because it is right on its own terms, not because it fixed anything.
     */
    '/((?!api/webhooks|api/fleet-photo|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}

import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

import {
  isMfaExemptPath,
  MFA_PATH,
  needsMfaChallenge,
  resolveAssuranceLevels,
} from '@/lib/auth/mfa'
import { SUPABASE_AUTH_COOKIE_NAME, supabaseServerUrl } from '@/lib/supabase/url'

export async function middleware(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request })

  const supabase = createServerClient(
    supabaseServerUrl(),
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookieOptions: { name: SUPABASE_AUTH_COOKIE_NAME },
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) => request.cookies.set(name, value))
          supabaseResponse = NextResponse.next({ request })
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          )
        },
      },
    }
  )

  const { data: { user } } = await supabase.auth.getUser()

  // Cookie hygiene: sessions written under the old host-derived names
  // (`sb-127-auth-token.0`, `sb-localhost-auth-token`, …) before the name
  // was pinned are never read again but keep inflating every request —
  // enough of them and nginx/Node reject the headers outright (400/431).
  // Expire anything that looks like a Supabase auth cookie but isn't ours.
  const legacyAuthCookies = request.cookies
    .getAll()
    .filter(
      (c) =>
        /^sb-.+-auth-token(\.\d+)?$/.test(c.name) &&
        !c.name.startsWith(SUPABASE_AUTH_COOKIE_NAME),
    )
  const expireLegacy = (res: NextResponse) => {
    for (const c of legacyAuthCookies) res.cookies.set(c.name, '', { path: '/', maxAge: 0 })
    return res
  }

  // MFA (round 2 spec, section 7). A user who owns a verified TOTP
  // factor but whose session is still `aal1` (password only) may reach
  // nothing but the challenge page and our own auth API until they
  // enter the code. One extra *local* call: the AAL comes from the JWT
  // in the cookie; the factor list rides on the `getUser()` result we
  // already paid for, so a factor enrolled on another device counts
  // immediately instead of after the next token refresh.
  if (user && !isMfaExemptPath(request.nextUrl.pathname)) {
    const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel()
    const levels = resolveAssuranceLevels(aal?.currentLevel, user.factors)
    if (needsMfaChallenge(levels)) {
      if (request.nextUrl.pathname.startsWith('/api/')) {
        return expireLegacy(NextResponse.json(
          { error: 'Two-step verification required', code: 'mfa_required' },
          { status: 401 },
        ))
      }
      const url = request.nextUrl.clone()
      url.pathname = MFA_PATH
      url.search = ''
      return expireLegacy(NextResponse.redirect(url))
    }
  }

  // Auth pages - redirect to dashboard if already logged in.
  // Exception: when an invite token is in the query string we
  // send the already-signed-in user to /join/<token> instead so
  // they can accept the invitation in one click. Without this,
  // a forwarded invite link to someone who's already signed in
  // would silently drop them on /dashboard.
  if (user && (
    request.nextUrl.pathname === '/login' ||
    request.nextUrl.pathname === '/signup' ||
    request.nextUrl.pathname === '/forgot-password'
  )) {
    const url = request.nextUrl.clone()
    const inviteToken = request.nextUrl.searchParams.get('invite')
    if (
      inviteToken &&
      (request.nextUrl.pathname === '/login' ||
        request.nextUrl.pathname === '/signup')
    ) {
      url.pathname = `/join/${encodeURIComponent(inviteToken)}`
      url.search = ''
    } else {
      url.pathname = '/dashboard'
      url.search = ''
    }
    return expireLegacy(NextResponse.redirect(url))
  }

  // Protected pages - redirect to login if not authenticated
  const protectedPaths = ['/dashboard', '/inbox', '/contacts', '/pipelines', '/broadcasts', '/automations', '/settings']
  if (!user && protectedPaths.some(path => request.nextUrl.pathname.startsWith(path))) {
    const url = request.nextUrl.clone()
    url.pathname = '/login'
    return expireLegacy(NextResponse.redirect(url))
  }

  // API routes that need auth (not webhooks)
  if (!user && request.nextUrl.pathname.startsWith('/api/whatsapp/') &&
      !request.nextUrl.pathname.includes('/webhook')) {
    return expireLegacy(NextResponse.json({ error: 'Unauthorized' }, { status: 401 }))
  }

  return expireLegacy(supabaseResponse)
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}

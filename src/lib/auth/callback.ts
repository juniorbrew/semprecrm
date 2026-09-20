// ============================================================
// Pure helpers for /auth/callback — the page every e-mail link
// (confirm sign-up, reset password, invite, e-mail change, magic
// link) lands on. Kept free of Next/Supabase so they are testable.
// ============================================================

import type { EmailOtpType } from '@supabase/supabase-js'

const OTP_TYPES: ReadonlySet<string> = new Set<EmailOtpType>([
  'signup',
  'invite',
  'magiclink',
  'recovery',
  'email_change',
  'email',
])

export function parseOtpType(raw: string | null): EmailOtpType | null {
  return raw && OTP_TYPES.has(raw) ? (raw as EmailOtpType) : null
}

/**
 * Where to send the user after the link is verified. Accepts a
 * relative path or a same-origin absolute URL (GoTrue's `RedirectTo`
 * is absolute); anything else — other hosts, `//evil`, javascript: —
 * falls back to `/dashboard`. A recovery link always goes to the
 * password form regardless of what the query says.
 */
export function safeNextPath(raw: string | null, origin: string, type: EmailOtpType | null): string {
  if (type === 'recovery') return '/reset-password'
  if (!raw) return '/dashboard'
  let path = raw.trim()
  if (/^https?:\/\//i.test(path)) {
    try {
      const u = new URL(path)
      if (u.origin !== origin) return '/dashboard'
      path = u.pathname + u.search
    } catch {
      return '/dashboard'
    }
  }
  if (!path.startsWith('/') || path.startsWith('//') || path.startsWith('/\\')) return '/dashboard'
  if (path.startsWith('/auth/callback')) return '/dashboard'
  return path
}

/**
 * The origin the visitor actually used. Behind Nginx/PM2 the request
 * URL Next sees is the upstream (`https://localhost:3000`), so the
 * proxy's `X-Forwarded-Host` / `X-Forwarded-Proto` win when present;
 * a direct hit (dev server) falls back to the request URL itself.
 */
export function publicOrigin(requestUrl: string, headers: Headers): string {
  const fwdHost = headers.get('x-forwarded-host')?.split(',')[0].trim()
  if (fwdHost && /^[a-z0-9.-]+(:\d+)?$/i.test(fwdHost)) {
    const proto = headers.get('x-forwarded-proto')?.split(',')[0].trim()
    return `${proto === 'http' ? 'http' : 'https'}://${fwdHost}`
  }
  return new URL(requestUrl).origin
}

/** Login-page notice shown after a callback outcome (`/login?notice=…`). */
export type CallbackNotice = 'link_invalid' | 'email_confirmed'

export function loginNoticeUrl(origin: string, notice: CallbackNotice): string {
  return `${origin}/login?notice=${notice}`
}

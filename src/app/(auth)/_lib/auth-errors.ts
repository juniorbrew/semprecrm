// ============================================================
// Supabase Auth → friendly copy.
//
// GoTrue answers sign-in / sign-up / reset calls with terse English
// ("Invalid login credentials", "Email not confirmed"). The auth
// pages used to print `error.message` verbatim, which leaked English
// into pt-BR and told the user nothing about what to do next. This
// maps the common cases — by the stable `code` when supabase-js
// provides one, then by message pattern for older shapes — to an
// English key that lives in the i18n dictionary (src/lib/i18n-dict/
// auth.ts). Callers render it through `t()`.
//
// Unknown errors collapse to a generic retry message; the raw text
// is still logged so it is not lost for debugging.
// ============================================================

export interface AuthErrorLike {
  message: string
  code?: string | null
  status?: number
}

export const AUTH_ERROR_INVALID_CREDENTIALS =
  'Incorrect e-mail or password. Check the details and try again.'
export const AUTH_ERROR_EMAIL_NOT_CONFIRMED =
  'Your e-mail is not confirmed yet. Open the confirmation link we sent you, then sign in.'
export const AUTH_ERROR_ALREADY_REGISTERED =
  'This e-mail is already registered. Sign in or reset your password.'
export const AUTH_ERROR_EMAIL_RATE_LIMIT =
  'Too many e-mails were sent to this address. Wait a few minutes and try again.'
export const AUTH_ERROR_TOO_MANY_REQUESTS =
  'Too many attempts. Wait a moment and try again.'
export const AUTH_ERROR_WEAK_PASSWORD = 'Password must be at least 6 characters'
export const AUTH_ERROR_INVALID_EMAIL = 'Enter a valid email address'
export const AUTH_ERROR_SIGNUP_DISABLED =
  'New sign-ups are disabled right now. Contact support.'
export const AUTH_ERROR_SAME_PASSWORD =
  'The new password must be different from the current one.'
export const AUTH_ERROR_LINK_EXPIRED =
  'This link is invalid or has expired. Request a new one.'
export const AUTH_ERROR_NETWORK =
  'Could not reach the server. Check your connection and try again.'
export const AUTH_ERROR_GENERIC = 'Something went wrong. Please try again.'

const BY_CODE: Record<string, string> = {
  invalid_credentials: AUTH_ERROR_INVALID_CREDENTIALS,
  email_not_confirmed: AUTH_ERROR_EMAIL_NOT_CONFIRMED,
  phone_not_confirmed: AUTH_ERROR_EMAIL_NOT_CONFIRMED,
  user_already_exists: AUTH_ERROR_ALREADY_REGISTERED,
  email_exists: AUTH_ERROR_ALREADY_REGISTERED,
  over_email_send_rate_limit: AUTH_ERROR_EMAIL_RATE_LIMIT,
  over_request_rate_limit: AUTH_ERROR_TOO_MANY_REQUESTS,
  over_sms_send_rate_limit: AUTH_ERROR_TOO_MANY_REQUESTS,
  weak_password: AUTH_ERROR_WEAK_PASSWORD,
  email_address_invalid: AUTH_ERROR_INVALID_EMAIL,
  validation_failed: AUTH_ERROR_INVALID_EMAIL,
  signup_disabled: AUTH_ERROR_SIGNUP_DISABLED,
  email_provider_disabled: AUTH_ERROR_SIGNUP_DISABLED,
  same_password: AUTH_ERROR_SAME_PASSWORD,
  otp_expired: AUTH_ERROR_LINK_EXPIRED,
  bad_code_verifier: AUTH_ERROR_LINK_EXPIRED,
  flow_state_expired: AUTH_ERROR_LINK_EXPIRED,
  flow_state_not_found: AUTH_ERROR_LINK_EXPIRED,
}

const BY_MESSAGE: Array<[RegExp, string]> = [
  [/invalid login credentials|invalid email or password/i, AUTH_ERROR_INVALID_CREDENTIALS],
  [/email not confirmed/i, AUTH_ERROR_EMAIL_NOT_CONFIRMED],
  [/already registered|already been registered|already exists/i, AUTH_ERROR_ALREADY_REGISTERED],
  [/email rate limit/i, AUTH_ERROR_EMAIL_RATE_LIMIT],
  [/for security purposes|too many requests|rate limit/i, AUTH_ERROR_TOO_MANY_REQUESTS],
  [/password should be at least|password is known to be weak|weak password|requires a valid password/i, AUTH_ERROR_WEAK_PASSWORD],
  [/unable to validate email|invalid format|invalid email/i, AUTH_ERROR_INVALID_EMAIL],
  [/signups? not allowed|signups? (are )?disabled/i, AUTH_ERROR_SIGNUP_DISABLED],
  [/different from the old password|same password/i, AUTH_ERROR_SAME_PASSWORD],
  [/link is invalid or has expired|token has expired|otp expired/i, AUTH_ERROR_LINK_EXPIRED],
  [/failed to fetch|networkerror|network request failed|load failed|fetch failed/i, AUTH_ERROR_NETWORK],
]

/**
 * English dictionary key for a Supabase Auth error. Pass the result
 * through `t()` before rendering.
 */
export function friendlyAuthError(error: AuthErrorLike | null | undefined): string {
  if (!error) return AUTH_ERROR_GENERIC
  const code = error.code?.trim()
  if (code && BY_CODE[code]) return BY_CODE[code]
  const message = error.message ?? ''
  for (const [pattern, key] of BY_MESSAGE) if (pattern.test(message)) return key
  if (error.status === 429) return AUTH_ERROR_TOO_MANY_REQUESTS
  return AUTH_ERROR_GENERIC
}

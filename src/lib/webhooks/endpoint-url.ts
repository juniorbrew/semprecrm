import { isDeliverableUrl, type Resolver } from './ssrf'

export type UrlCheck = { ok: true; url: string } | { ok: false; error: string }

/**
 * Registration-time check for a webhook URL: https only, no credentials,
 * public address. Delivery re-checks (and pins DNS) on every request.
 */
export async function validateEndpointUrl(raw: unknown, resolver?: Resolver): Promise<UrlCheck> {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2048) {
    return { ok: false, error: 'Enter a valid URL' }
  }
  let u: URL
  try {
    u = new URL(raw.trim())
  } catch {
    return { ok: false, error: 'Enter a valid URL' }
  }
  if (u.protocol !== 'https:') return { ok: false, error: 'The URL must use https' }
  if (u.username || u.password) return { ok: false, error: 'The URL cannot contain a username or password' }
  if (!(await isDeliverableUrl(u.toString(), resolver))) {
    return { ok: false, error: 'This address is not reachable from the internet' }
  }
  return { ok: true, url: u.toString() }
}

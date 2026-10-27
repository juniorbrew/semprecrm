import crypto from 'node:crypto'

/**
 * Verify `X-Hub-Signature-256` on the Instagram / Messenger webhook.
 *
 * Meta signs the raw body with the secret of the app that owns the
 * subscription: the Messenger (Page) subscription uses `META_APP_SECRET`,
 * the Instagram-login app has its own `INSTAGRAM_APP_SECRET`. Either one
 * validates; with neither configured we fail closed.
 */
export function verifyMessagingSignature(
  rawBody: string,
  signatureHeader: string | null,
  env: Record<string, string | undefined> = process.env,
): boolean {
  const secrets = [env.META_APP_SECRET, env.INSTAGRAM_APP_SECRET].filter((s): s is string => !!s)
  if (secrets.length === 0) {
    console.error('[meta-messaging] META_APP_SECRET / INSTAGRAM_APP_SECRET not set — rejecting request.')
    return false
  }
  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) return false
  const got = Buffer.from(signatureHeader)
  return secrets.some((secret) => {
    const expected = Buffer.from(
      'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex'),
    )
    return got.length === expected.length && crypto.timingSafeEqual(got, expected)
  })
}

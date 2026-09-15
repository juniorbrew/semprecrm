// ============================================================
// Public URL + copy-paste examples for a lead source. Pure.
// ============================================================

import { DEFAULT_FIELD_MAP, normalizeFieldMap } from './map-fields'

export const LEAD_WEBHOOK_PATH = '/api/v1/webhooks/in/'

/**
 * Base URL the webhook is reachable at. `NEXT_PUBLIC_SITE_URL` when the
 * admin set it (the one the customer's forms must use), else the page's
 * own origin, else empty (server render without env).
 */
export function resolveSiteUrl(
  env: string | undefined = process.env.NEXT_PUBLIC_SITE_URL,
  origin: string | undefined = typeof window !== 'undefined' ? window.location.origin : undefined,
): string {
  const explicit = env?.trim().replace(/\/+$/, '')
  if (explicit) return explicit
  return (origin ?? '').replace(/\/+$/, '')
}

export function leadWebhookUrl(token: string, siteUrl: string = resolveSiteUrl()): string {
  return `${siteUrl}${LEAD_WEBHOOK_PATH}${token}`
}

/** Payload keys the source expects, honouring its field map. */
export function exampleKeys(fieldMap: unknown): { name: string; phone: string; email: string; company: string } {
  const m = normalizeFieldMap(fieldMap)
  return {
    name: m.name ?? DEFAULT_FIELD_MAP.name,
    phone: m.phone ?? DEFAULT_FIELD_MAP.phone,
    email: m.email ?? DEFAULT_FIELD_MAP.email,
    company: m.company ?? DEFAULT_FIELD_MAP.company,
  }
}

export function curlExample(url: string, fieldMap: unknown): string {
  const k = exampleKeys(fieldMap)
  const body = JSON.stringify(
    { [k.name]: 'Ana Silva', [k.phone]: '5511999990000', [k.email]: 'ana@exemplo.com', [k.company]: 'Exemplo Ltda' },
    null,
    2,
  )
  return `curl -X POST "${url}" \\n  -H "Content-Type: application/json" \\n  -d '${body}'`
}

export function htmlFormExample(url: string, fieldMap: unknown): string {
  const k = exampleKeys(fieldMap)
  return [
    `<form action="${url}" method="POST">`,
    `  <input name="${k.name}" placeholder="Nome" required>`,
    `  <input name="${k.phone}" type="tel" placeholder="WhatsApp (55 + DDD + número)" required>`,
    `  <input name="${k.email}" type="email" placeholder="E-mail">`,
    `  <button type="submit">Quero saber mais</button>`,
    `</form>`,
  ].join('\n')
}

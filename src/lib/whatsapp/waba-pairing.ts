/**
 * Pure checks for the WABA / phone-number pairing a user submits on the
 * WhatsApp settings form. Issue #505: a wrong-but-valid WABA ID used to
 * save fine and only show up later as a webhook that never fires,
 * because the WABA that got subscribed wasn't the one owning the number.
 * Ported from wacrm #505.
 */

import type { SubscribedApp, WabaPhoneNumber } from './meta-api'

/**
 * Meta object ids (Phone Number ID, WABA ID, App ID) are decimal digit
 * strings. Anything else — a "+1 555..." phone number, a display name, a
 * pasted URL — is a copy mistake we can name up front instead of letting
 * Meta answer with "(#100) Unsupported get request".
 */
export function isNumericMetaId(value: unknown): value is string {
  return typeof value === 'string' && /^\d+$/.test(value)
}

export function phoneNumberBelongsToWaba(
  numbers: readonly WabaPhoneNumber[],
  phoneNumberId: string,
): boolean {
  return numbers.some((n) => n.id === phoneNumberId)
}

/**
 * Error text for a phone number that is not under the given WABA. Lists
 * the numbers Meta *does* see under it so the user can tell at a glance
 * whether they pasted the wrong WABA or the wrong phone.
 */
export function describeWabaPhoneMismatch(
  numbers: readonly WabaPhoneNumber[],
  phoneNumberId: string,
  wabaId: string,
  /** SempreCRM: the settings page shows the pt-BR text by default. */
  lang: 'en' | 'pt-BR' = 'en',
): string {
  const pt = lang === 'pt-BR'
  const head = pt
    ? `O ID do número de telefone ${phoneNumberId} não pertence à conta do WhatsApp Business ${wabaId}.`
    : `Phone Number ID ${phoneNumberId} does not belong to WhatsApp Business Account ${wabaId}.`
  const tail = pt
    ? ' Confira os dois valores em Meta → WhatsApp → Configuração da API: o ID da WABA mostrado lá ' +
      'deve ser o que lista este número de telefone.'
    : ' Check both values in Meta → WhatsApp → API Setup: the WABA ID shown there must be the one ' +
      'that lists this phone number.'
  if (numbers.length === 0) {
    return pt
      ? `${head} A Meta não lista nenhum número de telefone nessa WABA.${tail}`
      : `${head} Meta lists no phone numbers under that WABA.${tail}`
  }
  const listed = numbers
    .slice(0, 5)
    .map((n) => (n.display_phone_number ? `${n.display_phone_number} (${n.id})` : n.id))
    .join(', ')
  const rest = numbers.length - 5
  const more = numbers.length > 5 ? (pt ? ` e mais ${rest}` : ` and ${rest} more`) : ''
  return pt
    ? `${head} A Meta lista estes números nela: ${listed}${more}.${tail}`
    : `${head} Meta lists these numbers under it: ${listed}${more}.${tail}`
}

export interface AppSubscriptionState {
  /** At least one app is subscribed to the WABA. */
  subscribed: boolean
  /**
   * Whether META_APP_ID is among them. `null` when META_APP_ID is not
   * configured — then `subscribed` is the best we can say (the token
   * belongs to one app, and Meta only returns apps that token can see).
   */
  appIdMatch: boolean | null
}

export function appSubscriptionState(
  subs: readonly SubscribedApp[],
  appId: string | null | undefined,
): AppSubscriptionState {
  const ids = subs
    .map((s) => s.whatsapp_business_api_data?.id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0)
  const wanted = appId?.trim()
  return {
    subscribed: subs.length > 0,
    appIdMatch: wanted ? ids.includes(wanted) : null,
  }
}

/**
 * What the settings page should say about the WABA subscription the GET
 * health check reported. `app_id_match === false` means the WABA is
 * subscribed — but to a *different* Meta app, so inbound webhooks go
 * there, not here: treat it as not subscribed (review of wacrm #505).
 */
export type SubscriptionNotice = 'subscribed' | 'not_subscribed' | 'other_app' | 'unknown'

export function subscriptionNotice(state: {
  subscribed: boolean | null
  app_id_match: boolean | null
}): SubscriptionNotice {
  if (state.subscribed === false) return 'not_subscribed'
  if (state.subscribed === true) return state.app_id_match === false ? 'other_app' : 'subscribed'
  return 'unknown'
}

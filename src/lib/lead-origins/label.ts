// ============================================================
// Names for an origin. Same priority as the SQL buckets of origin_report (migration 109):
// ad -> campaign -> referrer host -> "Direto ou não identificado". Pure.
// ============================================================

import { safeHttpUrl } from './normalize'
import type { LeadOrigin, OriginChannel } from './types'

export const DIRECT_LABEL = 'Direto ou não identificado'

export const PAID_GOOGLE = 'Google Ads'
export const PAID_META = 'Facebook/Instagram Ads'

export type OriginName =
  | { type: 'ad'; name: string; channel: OriginChannel }
  | { type: 'campaign'; name: string; source: string | null; channel: OriginChannel }
  | { type: 'referrer'; name: string; channel: OriginChannel }
  /** Only a Google / Facebook click id came with the visit: named after the network. */
  | { type: 'paid'; name: string }
  | { type: 'direct' }

type NameFields = Pick<
  LeadOrigin,
  'channel' | 'kind' | 'headline' | 'ad_id' | 'source_id' | 'utm_campaign' | 'utm_source' | 'referrer_host' | 'click_id_type'
>

/** Which bucket a touch falls in, and what it is called there. */
export function originName(o: NameFields | null | undefined): OriginName {
  if (!o) return { type: 'direct' }
  if (o.kind === 'ad' || o.kind === 'post') {
    return { type: 'ad', name: o.headline ?? o.ad_id ?? o.source_id ?? '', channel: o.channel }
  }
  if (o.utm_campaign) return { type: 'campaign', name: o.utm_campaign, source: o.utm_source, channel: o.channel }
  if (o.kind === 'link' && o.source_id) return { type: 'campaign', name: o.source_id, source: o.utm_source, channel: o.channel }
  if (o.referrer_host) return { type: 'referrer', name: o.referrer_host, channel: o.channel }
  if (o.click_id_type === 'gclid') return { type: 'paid', name: PAID_GOOGLE }
  if (o.click_id_type === 'fbclid') return { type: 'paid', name: PAID_META }
  return { type: 'direct' }
}

export const CHANNEL_LABEL: Record<OriginChannel | '', string> = {
  whatsapp: 'WhatsApp',
  whatsapp_qr: 'WhatsApp QR Code',
  instagram: 'Instagram',
  messenger: 'Messenger',
  site_bot: 'Site',
  webhook: 'Formulário',
  '': '',
}

const CHANNEL_LABEL_EN: Record<OriginChannel | '', string> = { ...CHANNEL_LABEL, site_bot: 'Website', webhook: 'Form' }

/** Channel name for the screen: brands as they are, "Site" / "Formulário" in the user's language. */
export function channelLabel(channel: OriginChannel | '', language: string = 'pt-BR'): string {
  return (language === 'pt-BR' ? CHANNEL_LABEL : CHANNEL_LABEL_EN)[channel]
}

/** One-line plain text (CSV, tooltips). Brand and channel names are not translated. */
export function originLabel(o: NameFields | null | undefined): string {
  const n = originName(o)
  switch (n.type) {
    case 'ad':
      return `${n.name ? `Anúncio "${n.name}"` : 'Anúncio'} · ${CHANNEL_LABEL[n.channel]}`
    case 'campaign':
      return `Campanha "${n.name}"${n.source ? ` · ${n.source}` : ''}`
    case 'referrer':
      return `Site de origem ${n.name}`
    case 'paid':
      return n.name
    default:
      return DIRECT_LABEL
  }
}

/** Safe `href` for the "see the ad" link (http/https only), else null. */
export function originLink(o: Pick<LeadOrigin, 'source_url'> | null | undefined): string | null {
  return safeHttpUrl(o?.source_url ?? null)
}

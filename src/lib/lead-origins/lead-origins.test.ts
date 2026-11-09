import { describe, expect, it, vi } from 'vitest'

import {
  DIRECT_LABEL,
  normalizeTouch,
  originLabel,
  originLink,
  originName,
  parseBaileysAd,
  parseBodyOrigin,
  parseMessagingReferral,
  parseUrlOrigin,
  parseWhatsAppReferral,
  type LeadOrigin,
} from './index'
import { recordTouch } from './record'

// Anonymized samples shaped like the providers' documented payloads.
const WA_REFERRAL = {
  source_url: 'https://fb.me/1AbCdEf',
  source_id: '120210000000001',
  source_type: 'ad',
  headline: 'Promoção sofás',
  body: 'Até 40% de desconto',
  media_type: 'image',
  image_url: 'https://scontent.example/x.jpg',
  ctwa_clid: 'AfAbC123_ctwa',
}

describe('parseWhatsAppReferral', () => {
  it('reads a Click-to-WhatsApp ad', () => {
    expect(parseWhatsAppReferral(WA_REFERRAL)).toEqual({
      channel: 'whatsapp',
      kind: 'ad',
      adId: '120210000000001',
      sourceId: '120210000000001',
      sourceUrl: 'https://fb.me/1AbCdEf',
      headline: 'Promoção sofás',
      utmSource: null,
      utmMedium: null,
      utmCampaign: null,
      utmContent: null,
      utmTerm: null,
      referrerHost: null,
      clickIdType: 'ctwa_clid',
      clickId: 'AfAbC123_ctwa',
    })
  })
  it('a post is not an ad id', () => {
    const t = parseWhatsAppReferral({ ...WA_REFERRAL, source_type: 'post' })
    expect(t).toMatchObject({ kind: 'post', adId: null, sourceId: '120210000000001' })
  })
  it('an unknown source type with a url is a link', () => {
    expect(parseWhatsAppReferral({ source_url: 'https://example.com/x', source_type: 'weird' })).toMatchObject({ kind: 'link' })
  })
  it('accepts a numeric source id', () => {
    expect(parseWhatsAppReferral({ source_type: 'ad', source_id: 120210000000001 })).toMatchObject({ adId: '120210000000001' })
  })
  it('ignores missing fields, wrong types and empty objects', () => {
    for (const bad of [null, undefined, 'x', 42, [], {}, { source_type: 'ad' }, { source_id: {}, headline: ['x'], ctwa_clid: false }]) {
      expect(parseWhatsAppReferral(bad), JSON.stringify(bad)).toBeNull()
    }
  })
  it('drops a non-http source_url (the value becomes a link) but keeps the rest', () => {
    const t = parseWhatsAppReferral({ ...WA_REFERRAL, source_url: 'javascript:alert(1)' })
    expect(t?.sourceUrl).toBeNull()
    expect(t?.headline).toBe('Promoção sofás')
  })
  it('clamps giant strings to the database limits', () => {
    const t = parseWhatsAppReferral({ ...WA_REFERRAL, headline: 'h'.repeat(5000), ctwa_clid: 'c'.repeat(5000), source_id: 's'.repeat(5000) })
    expect(t?.headline).toHaveLength(300)
    expect(t?.clickId).toHaveLength(600)
    expect(t?.sourceId).toHaveLength(200)
  })
  it('strips control characters and blanks', () => {
    const t = parseWhatsAppReferral({ ...WA_REFERRAL, headline: '  Promo\u0000\nção ​ ' })
    expect(t?.headline).not.toMatch(/[\u0000\n]/)
    expect(parseWhatsAppReferral({ source_type: 'ad', source_id: '   ', headline: '\n\t' })).toBeNull()
  })
  it('a giant source_url is dropped, not truncated into a broken link', () => {
    expect(parseWhatsAppReferral({ ...WA_REFERRAL, source_url: 'https://x.com/' + 'a'.repeat(2000) })?.sourceUrl).toBeNull()
  })
})

describe('parseBaileysAd', () => {
  const AD = {
    title: 'Promoção sofás',
    body: 'texto',
    source_type: 'ad',
    source_id: '120210000000009',
    source_url: 'https://fb.me/xyz',
    ctwa_clid: 'AfXyz',
    source_app: 'instagram',
    conversion_source: 'FB_Ads',
  }
  it('reads the forwarded externalAdReply; the sender-written click id is never stored', () => {
    const t = parseBaileysAd(AD)
    expect(t).toMatchObject({ channel: 'whatsapp_qr', kind: 'ad', adId: '120210000000009', headline: 'Promoção sofás', sourceUrl: 'https://fb.me/xyz' })
    expect(t?.clickId).toBeNull()
    expect(t?.clickIdType).toBeNull()
  })
  it('an ad is recognised by an exact conversion source when the type is missing', () => {
    for (const c of ['FB_Ads', 'fb_ads', 'ads', 'ad', 'Ads']) expect(parseBaileysAd({ conversion_source: c, source_id: '1' }), c).toMatchObject({ kind: 'ad' })
  })
  it('a conversion source that merely contains "ad" is not an ad ("broadcast")', () => {
    expect(parseBaileysAd({ conversion_source: 'broadcast', source_id: '1' })).toBeNull()
    expect(parseBaileysAd({ conversion_source: 'badge', source_id: '1', source_url: 'https://fb.me/x' })).toMatchObject({ kind: 'link' })
    expect(parseBaileysAd({ conversion_source: 'ads_extra', source_id: '1' })).toBeNull()
  })
  it('the link is kept only for a Meta host; the sender controls everything else', () => {
    for (const ok of ['https://fb.me/xyz', 'https://www.facebook.com/ads/1', 'https://m.facebook.com/x', 'https://instagram.com/p/1', 'https://l.instagram.com/?u=1', 'https://wa.me/5511', 'https://fb.com/x']) {
      expect(parseBaileysAd({ ...AD, source_url: ok })?.sourceUrl, ok).toBe(ok)
    }
    for (const bad of ['https://evil.example/fb.me', 'https://facebook.com.evil.example/x', 'https://notfacebook.com/x', 'https://facebook.com@evil.example/x', 'http://localhost/x', 'javascript:alert(1)']) {
      expect(parseBaileysAd({ ...AD, source_url: bad })?.sourceUrl ?? null, bad).toBeNull()
    }
  })
  it('a plain link preview to a non-Meta host is nothing; nothing at all is null', () => {
    expect(parseBaileysAd({ source_url: 'https://example.com/promo' })).toBeNull()
    expect(parseBaileysAd({ source_url: 'https://fb.me/promo' })).toMatchObject({ kind: 'link' })
    for (const bad of [null, 'x', 3, [], {}, { title: 'só título' }, { body: 'b' }]) expect(parseBaileysAd(bad)).toBeNull()
  })
  it('clamps and validates', () => {
    expect(parseBaileysAd({ ...AD, title: 't'.repeat(900), source_url: 'ftp://fb.me/y' })).toMatchObject({ sourceUrl: null })
    expect(parseBaileysAd({ ...AD, title: 't'.repeat(900) })?.headline).toHaveLength(300)
  })
})

describe('parseMessagingReferral', () => {
  const IG_AD = {
    ref: 'verao',
    source: 'ADS',
    type: 'OPEN_THREAD',
    ad_id: '23850000000002',
    ads_context_data: { ad_title: 'Coleção verão', photo_url: 'https://x/p.jpg', post_id: '17900000001' },
  }
  it('reads an Instagram / Messenger ad referral', () => {
    expect(parseMessagingReferral(IG_AD, 'instagram')).toMatchObject({
      channel: 'instagram',
      kind: 'ad',
      adId: '23850000000002',
      sourceId: '17900000001',
      headline: 'Coleção verão',
    })
    expect(parseMessagingReferral(IG_AD, 'messenger')).toMatchObject({ channel: 'messenger', kind: 'ad' })
  })
  it('a shortlink with ?ref= is a link keyed by the ref', () => {
    expect(parseMessagingReferral({ source: 'SHORTLINK', type: 'OPEN_THREAD', ref: 'bio-instagram' }, 'messenger')).toMatchObject({
      kind: 'link',
      sourceId: 'bio-instagram',
      adId: null,
    })
  })
  it('an ad without title or ad_id is still an ad when the source says ADS', () => {
    expect(parseMessagingReferral({ source: 'ads', ads_context_data: { post_id: '9' } }, 'instagram')).toMatchObject({ kind: 'ad', sourceId: '9' })
  })
  it('ignores missing fields and wrong types', () => {
    for (const bad of [null, undefined, '', 1, [], {}, { source: 'SHORTLINK' }, { ads_context_data: 'x', ad_id: {} }]) {
      expect(parseMessagingReferral(bad, 'instagram'), JSON.stringify(bad)).toBeNull()
    }
  })
  it('clamps giant strings', () => {
    const t = parseMessagingReferral({ ...IG_AD, ads_context_data: { ad_title: 'x'.repeat(4000) }, ref: 'r'.repeat(4000) }, 'instagram')
    expect(t?.headline).toHaveLength(300)
    expect(t?.sourceId?.length).toBeLessThanOrEqual(200)
  })
})

describe('parseUrlOrigin', () => {
  const PAGE = 'https://loja.com.br/sofas?utm_source=google&utm_medium=cpc&utm_campaign=black-friday&utm_content=a&utm_term=sofa+barato&gclid=Cj0KCQ&ref=abc#top'
  it('extracts campaign parameters and the referrer host only', () => {
    expect(parseUrlOrigin(PAGE, 'https://www.google.com/search?q=sofa+barato&secret=1', 'site_bot')).toEqual({
      channel: 'site_bot',
      kind: 'campaign',
      adId: null,
      sourceId: null,
      // only utm_* survive in the stored page url: no gclid, no ref, no fragment
      sourceUrl: 'https://loja.com.br/sofas?utm_source=google&utm_medium=cpc&utm_campaign=black-friday&utm_content=a&utm_term=sofa+barato',
      headline: null,
      utmSource: 'google',
      utmMedium: 'cpc',
      utmCampaign: 'black-friday',
      utmContent: 'a',
      utmTerm: 'sofa barato',
      referrerHost: 'google.com',
      clickIdType: 'gclid',
      clickId: 'Cj0KCQ',
    })
  })
  it('fbclid is a click id too', () => {
    expect(parseUrlOrigin('https://loja.com.br/?fbclid=IwAR1', '', 'site_bot')).toMatchObject({ kind: 'campaign', clickIdType: 'fbclid', clickId: 'IwAR1' })
  })
  it('accepts the bare host robo.js sends as referrer (with or without a port)', () => {
    expect(parseUrlOrigin('https://loja.com.br/', 'www.google.com', 'site_bot')).toMatchObject({ kind: 'referrer', referrerHost: 'google.com' })
    expect(parseUrlOrigin('https://loja.com.br/', 'blog.example.org:8443', 'site_bot')).toMatchObject({ referrerHost: 'blog.example.org' })
    expect(parseUrlOrigin('https://loja.com.br/', 'loja.com.br', 'site_bot')).toBeNull()
    expect(parseUrlOrigin('https://loja.com.br/', 'not a host/with path', 'site_bot')).toBeNull()
  })
  it('a referrer without campaign is a referrer touch', () => {
    expect(parseUrlOrigin('https://loja.com.br/', 'https://blog.example.org/post/1?x=2', 'site_bot')).toMatchObject({
      kind: 'referrer',
      referrerHost: 'blog.example.org',
      utmCampaign: null,
    })
  })
  it('same-site navigation and direct visits record nothing', () => {
    expect(parseUrlOrigin('https://loja.com.br/a', 'https://www.loja.com.br/b', 'site_bot')).toBeNull()
    expect(parseUrlOrigin('https://loja.com.br/', '', 'site_bot')).toBeNull()
    expect(parseUrlOrigin(undefined, undefined, 'site_bot')).toBeNull()
  })
  it('ignores junk urls and non-http schemes', () => {
    expect(parseUrlOrigin('not a url', 'javascript:alert(1)', 'site_bot')).toBeNull()
    expect(parseUrlOrigin('javascript:alert(1)?utm_source=x', 'data:text/html,hi', 'site_bot')).toBeNull()
    expect(parseUrlOrigin({}, [], 'site_bot')).toBeNull()
  })
  it('clamps giant values', () => {
    const t = parseUrlOrigin(`https://loja.com.br/?utm_source=${'s'.repeat(300)}&utm_campaign=${'c'.repeat(3000)}`, 'https://' + 'a'.repeat(300) + '.com', 'site_bot')
    expect(t?.utmCampaign).toHaveLength(200)
    expect(t?.utmSource).toHaveLength(120)
    expect(t?.referrerHost).toBeNull() // longer than a hostname can be
    expect(t?.sourceUrl == null || t.sourceUrl.length <= 1000).toBe(true)
  })
})

describe('parseBodyOrigin (webhook form)', () => {
  it('reads utm_* and click ids from the body, without touching other fields', () => {
    const body = { name: 'Ana', phone: '11999990000', utm_source: 'facebook', utm_campaign: 'verao', fbclid: 'IwAR9', page_url: 'https://loja.com.br/lp?utm_campaign=ignored', referrer: 'https://l.facebook.com/' }
    expect(parseBodyOrigin(body)).toMatchObject({
      channel: 'webhook',
      kind: 'campaign',
      utmSource: 'facebook',
      utmCampaign: 'verao', // the explicit field wins over the url
      referrerHost: 'l.facebook.com',
      clickIdType: 'fbclid',
    })
    expect(body.name).toBe('Ana')
  })
  it('a plain lead has no origin', () => {
    expect(parseBodyOrigin({ name: 'Ana', phone: '1' })).toBeNull()
    expect(parseBodyOrigin(null)).toBeNull()
    expect(parseBodyOrigin([])).toBeNull()
    expect(parseBodyOrigin({ utm_campaign: ['a', 'b'], utm_source: { x: 1 } })).toBeNull()
  })
  it('reads page_url only: `url` is often the lead\'s own website', () => {
    expect(parseBodyOrigin({ url: 'https://meusite.com.br/?utm_campaign=x' })).toBeNull()
    expect(parseBodyOrigin({ page_url: 'https://loja.com.br/lp?utm_campaign=lp' })).toMatchObject({ utmCampaign: 'lp' })
  })
  it('gclid beats fbclid when both are present (one click id per touch)', () => {
    expect(parseBodyOrigin({ gclid: 'G1', fbclid: 'F1' })).toMatchObject({ clickIdType: 'gclid', clickId: 'G1' })
  })
})

describe('normalizeTouch', () => {
  it('rejects unknown channels and kinds', () => {
    expect(normalizeTouch({ channel: 'telegram', kind: 'ad', adId: '1' })).toBeNull()
    expect(normalizeTouch({ channel: 'whatsapp', kind: 'banner', adId: '1' })).toBeNull()
    expect(normalizeTouch(null)).toBeNull()
  })
  it('keeps click id and type together or drops both', () => {
    expect(normalizeTouch({ channel: 'whatsapp', kind: 'ad', adId: '1', clickId: 'abc' })).toMatchObject({ clickId: null, clickIdType: null })
    expect(normalizeTouch({ channel: 'whatsapp', kind: 'ad', adId: '1', clickIdType: 'gclid' })).toMatchObject({ clickId: null, clickIdType: null })
    expect(normalizeTouch({ channel: 'whatsapp', kind: 'ad', adId: '1', clickIdType: 'other', clickId: 'x' })).toMatchObject({ clickId: null })
  })
  it('a touch that identifies nothing is null', () => {
    expect(normalizeTouch({ channel: 'site_bot', kind: 'campaign' })).toBeNull()
  })
})

const row = (o: Partial<LeadOrigin>): LeadOrigin => ({
  id: 'o1',
  account_id: 'a',
  contact_id: 'c',
  conversation_id: null,
  channel: 'instagram',
  kind: 'ad',
  ad_id: null,
  source_id: null,
  source_url: null,
  headline: null,
  utm_source: null,
  utm_medium: null,
  utm_campaign: null,
  utm_content: null,
  utm_term: null,
  referrer_host: null,
  click_id_type: null,
  occurred_at: '2026-11-03T12:00:00Z',
  created_at: '2026-11-03T12:00:00Z',
  ...o,
})

describe('originName / originLabel (ad > campaign > referrer > direct)', () => {
  it('an ad wins over campaign and referrer fields', () => {
    const o = row({ headline: 'Promoção sofás', utm_campaign: 'x', referrer_host: 'google.com' })
    expect(originName(o)).toEqual({ type: 'ad', name: 'Promoção sofás', channel: 'instagram' })
    expect(originLabel(o)).toBe('Anúncio "Promoção sofás" · Instagram')
  })
  it('an ad without a title falls back to its ids', () => {
    expect(originName(row({ ad_id: '123' }))).toMatchObject({ name: '123' })
    expect(originLabel(row({ kind: 'post' }))).toBe('Anúncio · Instagram')
  })
  it('a campaign wins over the referrer', () => {
    const o = row({ channel: 'site_bot', kind: 'campaign', utm_campaign: 'black-friday', utm_source: 'google', referrer_host: 'google.com' })
    expect(originName(o)).toEqual({ type: 'campaign', name: 'black-friday', source: 'google', channel: 'site_bot' })
    expect(originLabel(o)).toBe('Campanha "black-friday" · google')
  })
  it('a link with a ref is a campaign named by the ref', () => {
    expect(originName(row({ kind: 'link', source_id: 'bio' }))).toMatchObject({ type: 'campaign', name: 'bio' })
  })
  it('a referrer host, then direct', () => {
    expect(originLabel(row({ channel: 'site_bot', kind: 'referrer', referrer_host: 'blog.example.org' }))).toBe('Site de origem blog.example.org')
    expect(originLabel(row({ channel: 'site_bot', kind: 'campaign' }))).toBe(DIRECT_LABEL)
    expect(originLabel(null)).toBe(DIRECT_LABEL)
    expect(originName(undefined)).toEqual({ type: 'direct' })
  })
  it('only a Google / Facebook click id: named after the network (after ad, campaign and referrer)', () => {
    expect(originName(row({ channel: 'site_bot', kind: 'campaign', click_id_type: 'gclid' }))).toEqual({ type: 'paid', name: 'Google Ads' })
    expect(originLabel(row({ channel: 'site_bot', kind: 'campaign', click_id_type: 'fbclid' }))).toBe('Facebook/Instagram Ads')
    expect(originName(row({ channel: 'site_bot', kind: 'campaign', click_id_type: 'gclid', referrer_host: 'google.com' }))).toMatchObject({ type: 'referrer' })
    expect(originName(row({ channel: 'site_bot', kind: 'campaign', click_id_type: 'gclid', utm_campaign: 'bf' }))).toMatchObject({ type: 'campaign' })
    // a WhatsApp click id is not a paid-network name
    expect(originName(row({ channel: 'whatsapp', kind: 'link', click_id_type: 'ctwa_clid' }))).toEqual({ type: 'direct' })
  })
  it('originLink only returns http(s)', () => {
    expect(originLink(row({ source_url: 'https://fb.me/x' }))).toBe('https://fb.me/x')
    expect(originLink(row({ source_url: 'javascript:alert(1)' }))).toBeNull()
    expect(originLink(null)).toBeNull()
  })
})

const RPC_ARGS = {
  accountId: 'acc',
  contactId: 'c1',
  conversationId: 'conv1',
  touch: parseWhatsAppReferral(WA_REFERRAL),
}

describe('recordTouch (one rpc: lock, dedup, cap, insert and pointers happen in the database)', () => {
  const dbWith = (rpc: (...a: unknown[]) => unknown) => ({ rpc: vi.fn(rpc) }) as never

  it('is a single record_lead_origin call with the normalized touch', async () => {
    const rpc = vi.fn(async () => ({ data: 'new-origin', error: null }))
    const r = await recordTouch({ rpc } as never, { ...RPC_ARGS, at: new Date('2026-11-03T12:00:00Z') })
    expect(r).toEqual({ recorded: true, originId: 'new-origin' })
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(rpc).toHaveBeenCalledWith('record_lead_origin', {
      p_account_id: 'acc',
      p_contact_id: 'c1',
      p_conversation_id: 'conv1',
      p_channel: 'whatsapp',
      p_kind: 'ad',
      p_ad_id: '120210000000001',
      p_source_id: '120210000000001',
      p_source_url: 'https://fb.me/1AbCdEf',
      p_headline: 'Promoção sofás',
      p_utm_source: null,
      p_utm_medium: null,
      p_utm_campaign: null,
      p_utm_content: null,
      p_utm_term: null,
      p_referrer_host: null,
      p_click_id_type: 'ctwa_clid',
      p_click_id: 'AfAbC123_ctwa',
      p_occurred_at: '2026-11-03T12:00:00.000Z',
      p_trusted_pointers: true,
    })
  })

  it('passes trustedPointers through (site / form submissions that did not create the contact are untrusted)', async () => {
    const rpc = vi.fn<(name: string, args: Record<string, unknown>) => Promise<{ data: null; error: null }>>(async () => ({ data: null, error: null }))
    await recordTouch({ rpc } as never, { ...RPC_ARGS, trustedPointers: false })
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_trusted_pointers: false })
  })

  it('a NULL answer (repeat inside 24h, or the daily cap) is "nothing written"', async () => {
    expect(await recordTouch(dbWith(async () => ({ data: null, error: null })), RPC_ARGS)).toEqual({ recorded: false })
  })

  it('no touch, or a touch that normalizes to nothing, never reaches the database', async () => {
    const rpc = vi.fn()
    expect(await recordTouch({ rpc } as never, { ...RPC_ARGS, touch: null })).toEqual({ recorded: false })
    expect(await recordTouch({ rpc } as never, { ...RPC_ARGS, touch: { channel: 'x' } as never })).toEqual({ recorded: false })
    expect(rpc).not.toHaveBeenCalled()
  })

  it('never throws and logs no personal data when the database fails', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await recordTouch(dbWith(async () => ({ data: null, error: { code: '23503', message: 'Promoção AfAbC123' } })), RPC_ARGS)).toEqual({ recorded: false })
    expect(await recordTouch(dbWith(async () => Promise.reject(new Error('boom Promoção'))), RPC_ARGS)).toEqual({ recorded: false })
    expect(await recordTouch(dbWith(() => { throw new Error('boom Promoção') }), RPC_ARGS)).toEqual({ recorded: false })
    const logged = spy.mock.calls.map((c) => c.join(' ')).join('\n')
    expect(logged).toContain('[lead-origins] record failed')
    expect(logged).toContain('23503')
    expect(logged).not.toMatch(/Promoção|AfAbC123|120210000000001/)
    spy.mockRestore()
  })

  it('gives up after a few seconds (the write is one statement, so nothing is half-done)', async () => {
    vi.useFakeTimers()
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const pending = recordTouch(dbWith(() => new Promise(() => {})), RPC_ARGS)
    await vi.advanceTimersByTimeAsync(3100)
    expect(await pending).toEqual({ recorded: false })
    expect(spy.mock.calls.join(' ')).toContain('timeout')
    spy.mockRestore()
    vi.useRealTimers()
  })
})

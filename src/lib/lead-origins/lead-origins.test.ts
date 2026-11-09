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
import { isDuplicateTouch, recordTouch, TOUCH_DEDUP_MS } from './record'

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
  it('reads the forwarded externalAdReply', () => {
    expect(parseBaileysAd(AD)).toMatchObject({
      channel: 'whatsapp_qr',
      kind: 'ad',
      adId: '120210000000009',
      headline: 'Promoção sofás',
      clickIdType: 'ctwa_clid',
      clickId: 'AfXyz',
    })
  })
  it('an ad is recognised by the conversion source when the type is missing', () => {
    expect(parseBaileysAd({ conversion_source: 'FB_Ads', source_id: '1' })).toMatchObject({ kind: 'ad' })
  })
  it('a plain link preview is a link; nothing at all is null', () => {
    expect(parseBaileysAd({ source_url: 'https://example.com/promo' })).toMatchObject({ kind: 'link' })
    for (const bad of [null, 'x', 3, [], {}, { title: 'só título' }, { body: 'b' }]) expect(parseBaileysAd(bad)).toBeNull()
  })
  it('clamps and validates', () => {
    expect(parseBaileysAd({ ...AD, title: 't'.repeat(900), source_url: 'ftp://x/y' })).toMatchObject({ sourceUrl: null })
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
  it('originLink only returns http(s)', () => {
    expect(originLink(row({ source_url: 'https://fb.me/x' }))).toBe('https://fb.me/x')
    expect(originLink(row({ source_url: 'javascript:alert(1)' }))).toBeNull()
    expect(originLink(null)).toBeNull()
  })
})

describe('dedup', () => {
  const touch = parseWhatsAppReferral(WA_REFERRAL)!
  const stored = (conv: string | null, over: Record<string, unknown> = {}) => ({
    channel: 'whatsapp',
    kind: 'ad',
    ad_id: '120210000000001',
    source_id: '120210000000001',
    utm_source: null,
    utm_campaign: null,
    utm_content: null,
    referrer_host: null,
    conversation_id: conv,
    ...over,
  })
  it('same ad, same conversation is a duplicate', () => {
    expect(isDuplicateTouch(touch, 'conv1', [stored('conv1')])).toBe(true)
  })
  it('another conversation, another ad or another channel is new', () => {
    expect(isDuplicateTouch(touch, 'conv2', [stored('conv1')])).toBe(false)
    expect(isDuplicateTouch(touch, 'conv1', [stored('conv1', { ad_id: '9', source_id: '9' })])).toBe(false)
    expect(isDuplicateTouch(touch, 'conv1', [stored('conv1', { channel: 'whatsapp_qr' })])).toBe(false)
    expect(isDuplicateTouch(touch, 'conv1', [])).toBe(false)
  })
  it('touches without a conversation (site) match each other', () => {
    const site = parseUrlOrigin('https://loja.com.br/?utm_campaign=bf', '', 'site_bot')!
    expect(isDuplicateTouch(site, null, [stored(null, { channel: 'site_bot', kind: 'campaign', ad_id: null, source_id: null, utm_campaign: 'bf' })])).toBe(true)
  })
})

/** A scripted stand-in for the two tables recordTouch uses. */
function fakeDb(opts: { recent?: Record<string, unknown>[]; insertError?: { code: string }; recentError?: { code: string } } = {}) {
  const calls: { table: string; op: string; payload?: Record<string, unknown>; eq: Record<string, unknown> }[] = []
  const from = (table: string) => {
    const call: (typeof calls)[number] = { table, op: 'select', eq: {} }
    calls.push(call)
    const b: Record<string, unknown> = {
      select: () => b,
      insert: (p: Record<string, unknown>) => ((call.op = 'insert'), (call.payload = p), b),
      update: (p: Record<string, unknown>) => ((call.op = 'update'), (call.payload = p), b),
      eq: (c: string, v: unknown) => ((call.eq[c] = v), b),
      is: (c: string, v: unknown) => ((call.eq[c] = v), b),
      gte: () => b,
      limit: () => b,
      single: () => Promise.resolve(opts.insertError ? { data: null, error: opts.insertError } : { data: { id: 'new-origin' }, error: null }),
      then: (f: (v: unknown) => unknown) =>
        Promise.resolve(
          call.op === 'select'
            ? { data: opts.recent ?? [], error: opts.recentError ?? null }
            : { data: null, error: null },
        ).then(f),
    }
    return b
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { db: { from } as any, calls }
}

describe('recordTouch', () => {
  const base = { accountId: 'acc', contactId: 'c1', conversationId: 'conv1', touch: parseWhatsAppReferral(WA_REFERRAL) }
  it('inserts the touch and moves first (only if empty) and last pointers', async () => {
    const { db, calls } = fakeDb()
    const r = await recordTouch(db, { ...base, at: new Date('2026-11-03T12:00:00Z') })
    expect(r).toEqual({ recorded: true, originId: 'new-origin' })
    const insert = calls.find((c) => c.op === 'insert')!
    expect(insert.payload).toMatchObject({ account_id: 'acc', contact_id: 'c1', conversation_id: 'conv1', channel: 'whatsapp', kind: 'ad', click_id_type: 'ctwa_clid', click_id: 'AfAbC123_ctwa', occurred_at: '2026-11-03T12:00:00.000Z' })
    const updates = calls.filter((c) => c.op === 'update')
    expect(updates[0]).toMatchObject({ table: 'contacts', payload: { first_origin_id: 'new-origin' }, eq: { id: 'c1', account_id: 'acc', first_origin_id: null } })
    expect(updates[1]).toMatchObject({ table: 'contacts', payload: { last_origin_id: 'new-origin' }, eq: { id: 'c1', account_id: 'acc' } })
  })
  it('a repeated touch inside the window writes nothing', async () => {
    const { db, calls } = fakeDb({
      recent: [{ channel: 'whatsapp', kind: 'ad', ad_id: '120210000000001', source_id: '120210000000001', utm_source: null, utm_campaign: null, utm_content: null, referrer_host: null, conversation_id: 'conv1' }],
    })
    expect(await recordTouch(db, base)).toEqual({ recorded: false })
    expect(calls.some((c) => c.op !== 'select')).toBe(false)
    expect(TOUCH_DEDUP_MS).toBe(24 * 3600 * 1000)
  })
  it('no touch, or a touch that normalizes to nothing, is a no-op', async () => {
    const { db, calls } = fakeDb()
    expect(await recordTouch(db, { ...base, touch: null })).toEqual({ recorded: false })
    expect(await recordTouch(db, { ...base, touch: { channel: 'x' } as never })).toEqual({ recorded: false })
    expect(calls).toHaveLength(0)
  })
  it('never throws and logs no personal data when the database fails', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    for (const opts of [{ insertError: { code: '23503' } }, { recentError: { code: '57014' } }]) {
      const { db } = fakeDb(opts)
      expect(await recordTouch(db, base)).toEqual({ recorded: false })
    }
    const logged = spy.mock.calls.map((c) => c.join(' ')).join('\n')
    expect(logged).toContain('[lead-origins] record failed')
    expect(logged).not.toMatch(/Promoção|AfAbC123|120210000000001/)
    spy.mockRestore()
  })
  it('never throws when the client itself throws', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = { from: () => { throw new Error('boom Promoção') } } as any
    expect(await recordTouch(db, base)).toEqual({ recorded: false })
    spy.mockRestore()
  })
})

import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import {
  buildCapiEvent,
  buildFbc,
  buildRequestBody,
  buildTestEvent,
  isMetaEligibleOrigin,
  normalizeEmail,
  normalizePhone,
  type ClaimedEvent,
} from './payload'

const h = (s: string) => createHash('sha256').update(s).digest('hex')

const row = (over: Partial<ClaimedEvent> = {}): ClaimedEvent => ({
  id: 'e1',
  account_id: 'a1',
  deal_id: 'd1',
  event_name: 'lead',
  event_id: 'sempre-d1-lead',
  attempts: 0,
  lease_until: '2026-11-09T12:02:00.000Z',
  occurred_at: '2026-11-09T12:00:00.000Z',
  value: null,
  currency: null,
  dataset_id: '123456789',
  token_enc: 'enc',
  contact_id: 'c1',
  contact_phone: '+55 (11) 90000-1111',
  contact_email: '  Ana@Example.COM ',
  contact_instagram_id: 'IGSID1',
  contact_messenger_id: 'PSID1',
  contact_anonymized: false,
  origin_channel: 'whatsapp',
  origin_kind: 'ad',
  origin_click_id_type: 'ctwa_clid',
  origin_click_id: 'CTWA-1',
  origin_occurred_at: '2026-11-09T11:00:00.000Z',
  waba_id: 'WABA1',
  channel_external_id: null,
  ...over,
})

describe('isMetaEligibleOrigin', () => {
  it.each([
    [{ channel: 'whatsapp', kind: 'ad', click_id_type: 'ctwa_clid' }, true],
    [{ channel: 'whatsapp', kind: 'ad', click_id_type: null }, false],
    [{ channel: 'whatsapp_qr', kind: 'ad', click_id_type: null }, false],
    [{ channel: 'instagram', kind: 'ad', click_id_type: null }, true],
    [{ channel: 'messenger', kind: 'ad', click_id_type: null }, true],
    [{ channel: 'instagram', kind: 'post', click_id_type: null }, false],
    [{ channel: 'site_bot', kind: 'link', click_id_type: 'fbclid', click_id: 'IwAR1abcdefghijklmnopqrstuv' }, true],
    [{ channel: 'webhook', kind: 'link', click_id_type: 'fbclid', click_id: 'IwAR1abcdefghijklmnopqrstuv' }, true],
    [{ channel: 'site_bot', kind: 'link', click_id_type: 'fbclid', click_id: 'FB1' }, false],
    [{ channel: 'site_bot', kind: 'link', click_id_type: 'fbclid', click_id: 'has space and ?? chars 123456' }, false],
    [{ channel: 'site_bot', kind: 'link', click_id_type: 'fbclid' }, false],
    [{ channel: 'site_bot', kind: 'link', click_id_type: 'gclid' }, false],
    [{ channel: null, kind: null, click_id_type: null }, false],
  ])('%j -> %s', (o, want) => expect(isMetaEligibleOrigin(o)).toBe(want))
})

describe('normalizers', () => {
  it('phone: digits with country code', () => {
    expect(normalizePhone('+55 (11) 90000-1111')).toBe('5511900001111')
    expect(normalizePhone('11 90000-1111')).toBe('5511900001111')
    expect(normalizePhone('abc')).toBeNull()
    expect(normalizePhone('011 90000-1111')).toBe('5511900001111') // leading zero stripped
    expect(normalizePhone('0 11 3000-1111')).toBe('551130001111')
    expect(normalizePhone('+1 415 555 2671')).toBe('14155552671') // already has a country code: unchanged
    expect(normalizePhone('+351 912 345 678')).toBe('351912345678')
    expect(normalizePhone('5511900001111')).toBe('5511900001111')
  })
  it('email: trim and lowercase', () => {
    expect(normalizeEmail('  Ana@Example.COM ')).toBe('ana@example.com')
    expect(normalizeEmail('nope')).toBeNull()
  })
  it('fbc uses the touch time in ms', () => {
    expect(buildFbc('IwAR1', '2026-11-09T11:00:00.000Z')).toBe(`fb.1.${Date.parse('2026-11-09T11:00:00.000Z')}.IwAR1`)
  })
})

describe('buildCapiEvent', () => {
  it('whatsapp lead: LeadSubmitted with ctwa_clid + WABA, no personal data', () => {
    const r = buildCapiEvent(row())
    expect(r).toEqual({
      ok: true,
      event: {
        event_name: 'LeadSubmitted',
        event_time: Math.floor(Date.parse('2026-11-09T12:00:00.000Z') / 1000),
        event_id: 'sempre-d1-lead',
        action_source: 'business_messaging',
        messaging_channel: 'whatsapp',
        user_data: { whatsapp_business_account_id: 'WABA1', ctwa_clid: 'CTWA-1' },
      },
    })
  })

  it('whatsapp purchase carries value and currency', () => {
    const r = buildCapiEvent(row({ event_name: 'purchase', event_id: 'sempre-d1-purchase', value: '1234.50', currency: 'BRL' }))
    expect(r.ok && r.event).toMatchObject({ event_name: 'Purchase', custom_data: { value: 1234.5, currency: 'BRL' } })
  })

  it('messenger: page id + PSID', () => {
    const r = buildCapiEvent(row({ origin_channel: 'messenger', origin_click_id_type: null, origin_click_id: null, channel_external_id: 'PAGE1' }))
    expect(r.ok && r.event).toMatchObject({
      action_source: 'business_messaging',
      messaging_channel: 'messenger',
      user_data: { page_id: 'PAGE1', page_scoped_user_id: 'PSID1' },
    })
  })

  it('instagram: business account id + ig_sid', () => {
    const r = buildCapiEvent(row({ origin_channel: 'instagram', origin_click_id_type: null, origin_click_id: null, channel_external_id: 'IGACC' }))
    expect(r.ok && r.event).toMatchObject({
      messaging_channel: 'instagram',
      user_data: { instagram_business_account_id: 'IGACC', ig_sid: 'IGSID1' },
    })
  })

  it('site: Lead as system_generated with fbc and SHA-256 of normalized phone and e-mail', () => {
    const r = buildCapiEvent(row({ origin_channel: 'site_bot', origin_kind: 'link', origin_click_id_type: 'fbclid', origin_click_id: 'IwAR1abcdefghijklmnopqrstuv' }))
    expect(r.ok && r.event).toMatchObject({
      event_name: 'Lead',
      action_source: 'system_generated',
      user_data: {
        fbc: `fb.1.${Date.parse('2026-11-09T11:00:00.000Z')}.IwAR1abcdefghijklmnopqrstuv`,
        ph: [h('5511900001111')],
        em: [h('ana@example.com')],
      },
    })
  })

  it('never puts a name, text, notes, IP or the raw phone / e-mail in the payload', () => {
    for (const channel of ['whatsapp', 'site_bot']) {
      const r = buildCapiEvent(
        row({ origin_channel: channel, origin_kind: 'link', origin_click_id_type: channel === 'whatsapp' ? 'ctwa_clid' : 'fbclid' }),
      )
      const json = JSON.stringify(r)
      expect(json).not.toMatch(/900001111|ana@|client_ip_address|client_user_agent|"fn"|"ln"/i)
    }
  })

  it.each([
    ['contact deleted', { contact_id: null }],
    ['contact anonymized', { contact_anonymized: true }],
    ['origin not from Meta', { origin_channel: 'whatsapp_qr', origin_click_id_type: null }],
    ['messenger without PSID', { origin_channel: 'messenger', origin_click_id_type: null, channel_external_id: 'P', contact_messenger_id: null }],
    ['site without fbclid', { origin_channel: 'site_bot', origin_click_id_type: 'fbclid', origin_click_id: null }],
    ['site with an implausible fbclid', { origin_channel: 'site_bot', origin_click_id_type: 'fbclid', origin_click_id: 'FB1' }],
  ] as const)('refuses: %s', (_n, over) => {
    expect(buildCapiEvent(row(over as Partial<ClaimedEvent>)).ok).toBe(false)
  })

  it.each([
    ['whatsapp without the WABA', { waba_id: null }],
    ['messenger without a connected page', { origin_channel: 'messenger', origin_click_id_type: null, channel_external_id: null }],
    ['instagram without a connected account', { origin_channel: 'instagram', origin_click_id_type: null, channel_external_id: null }],
  ] as const)('fails (an admin can fix it): %s', (_n, over) => {
    expect(buildCapiEvent(row(over as Partial<ClaimedEvent>))).toMatchObject({ ok: false, outcome: 'fail' })
  })

  it('cancels only what nobody can fix', () => {
    expect(buildCapiEvent(row({ contact_id: null }))).toMatchObject({ outcome: 'cancel' })
    expect(buildCapiEvent(row({ contact_anonymized: true }))).toMatchObject({ outcome: 'cancel' })
    expect(buildCapiEvent(row({ origin_channel: 'whatsapp_qr', origin_click_id_type: null }))).toMatchObject({ outcome: 'cancel' })
  })

  it('event_id is the stored stable one', () => {
    const a = buildCapiEvent(row())
    const b = buildCapiEvent(row())
    expect(a).toEqual(b)
    expect(a.ok && a.event.event_id).toBe('sempre-d1-lead')
  })
})

describe('request body', () => {
  it('test_event_code only when set; partner_agent always', () => {
    expect(buildRequestBody([{ a: 1 }])).toEqual({ data: [{ a: 1 }], partner_agent: 'SempreCRM' })
    expect(buildRequestBody([{ a: 1 }], 'TEST123')).toMatchObject({ test_event_code: 'TEST123' })
  })
  it('synthetic test event is well formed', () => {
    const e = buildTestEvent(new Date('2026-11-09T12:00:00Z')) as { user_data: { fbc: string; em: string[] }; action_source: string }
    expect(e.action_source).toBe('system_generated')
    expect(e.user_data.fbc).toMatch(/^fb\.1\.\d+\./)
    expect(e.user_data.em[0]).toBe(h('teste@example.com'))
  })
})

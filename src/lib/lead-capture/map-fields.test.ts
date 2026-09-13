import { describe, expect, it } from 'vitest'

import { coerceLeadValue, getPath, mapLeadFields, normalizeFieldMap } from './map-fields'
import { curlExample, exampleKeys, htmlFormExample, leadWebhookUrl, resolveSiteUrl } from './webhook-url'

describe('mapLeadFields — default map', () => {
  it('reads the english keys when the map is empty', () => {
    const m = mapLeadFields(
      { name: 'Ana', phone: '5511999990000', email: 'a@x.com', company: 'ACME' },
      {},
    )
    expect(m).toEqual({
      name: 'Ana',
      phone: '5511999990000',
      email: 'a@x.com',
      company: 'ACME',
      custom: {},
    })
  })

  it('understands the pt-BR spellings out of the box', () => {
    const m = mapLeadFields({ nome: 'Teste Lead', telefone: '5511988887777', empresa: 'X' }, null)
    expect(m.name).toBe('Teste Lead')
    expect(m.phone).toBe('5511988887777')
    expect(m.company).toBe('X')
    expect(m.email).toBeNull()
  })

  it('takes the first non-empty alias', () => {
    const m = mapLeadFields({ phone: '', celular: '5511', whatsapp: '5522' }, {})
    expect(m.phone).toBe('5511')
  })
})

describe('mapLeadFields — custom map', () => {
  it('uses the mapped keys and ignores the defaults for mapped fields', () => {
    const m = mapLeadFields(
      { name: 'wrong', full: 'Right Name', tel: '5511', phone: '9999' },
      { name: 'full', phone: 'tel' },
    )
    expect(m.name).toBe('Right Name')
    expect(m.phone).toBe('5511')
  })

  it('a mapped key that is absent yields null (no silent fallback)', () => {
    const m = mapLeadFields({ phone: '5511' }, { phone: 'telefone_principal' })
    expect(m.phone).toBeNull()
  })

  it('maps custom fields by id, only when present', () => {
    const m = mapLeadFields(
      { origem: 'Google Ads', utm: { campaign: 'inverno' } },
      { custom: { 'cf-1': 'origem', 'cf-2': 'utm.campaign', 'cf-3': 'nao_existe' } },
    )
    expect(m.custom).toEqual({ 'cf-1': 'Google Ads', 'cf-2': 'inverno' })
  })
})

describe('getPath — dotted paths', () => {
  const payload = {
    lead: { telefone: '5511', contato: { email: 'x@y.com' } },
    'lead.telefone': 'literal-wins',
    items: [{ phone: '1' }, { phone: '2' }],
  }

  it('prefers the literal key when it exists', () => {
    expect(getPath(payload, 'lead.telefone')).toBe('literal-wins')
  })

  it('walks nested objects and array indices', () => {
    expect(getPath(payload, 'lead.contato.email')).toBe('x@y.com')
    expect(getPath(payload, 'items.1.phone')).toBe('2')
    expect(getPath(payload, 'items.x.phone')).toBeUndefined()
    expect(getPath(payload, 'lead.nope.deeper')).toBeUndefined()
  })

  it('maps through a dotted path end to end', () => {
    const m = mapLeadFields({ lead: { fone: 5511999990000 } }, { phone: 'lead.fone' })
    expect(m.phone).toBe('5511999990000')
  })
})

describe('coerceLeadValue', () => {
  it('stringifies primitives, trims, takes the first array element, drops objects', () => {
    expect(coerceLeadValue('  Ana ')).toBe('Ana')
    expect(coerceLeadValue('   ')).toBeNull()
    expect(coerceLeadValue(5511)).toBe('5511')
    expect(coerceLeadValue(true)).toBe('true')
    expect(coerceLeadValue(['', 'x'])).toBe('x')
    expect(coerceLeadValue({ a: 1 })).toBeNull()
    expect(coerceLeadValue(null)).toBeNull()
  })
})

describe('normalizeFieldMap', () => {
  it('drops junk and empty strings', () => {
    expect(
      normalizeFieldMap({ name: ' nome ', phone: '', email: 3, custom: { a: 'x', b: '', c: 1 }, extra: 'z' }),
    ).toEqual({ name: 'nome', custom: { a: 'x' } })
    expect(normalizeFieldMap('nope')).toEqual({})
    expect(normalizeFieldMap([1])).toEqual({})
  })
})

describe('webhook-url helpers', () => {
  it('builds the URL from NEXT_PUBLIC_SITE_URL, falling back to the origin', () => {
    expect(resolveSiteUrl('https://crm.exemplo.com/', 'http://localhost:3101')).toBe('https://crm.exemplo.com')
    expect(resolveSiteUrl('', 'http://localhost:3101')).toBe('http://localhost:3101')
    expect(leadWebhookUrl('abc', 'https://crm.exemplo.com')).toBe('https://crm.exemplo.com/api/v1/webhooks/in/abc')
  })

  it('examples honour the field map', () => {
    expect(exampleKeys({ phone: 'telefone' })).toEqual({ name: 'name', phone: 'telefone', email: 'email', company: 'company' })
    const curl = curlExample('https://x/api/v1/webhooks/in/t', { name: 'nome' })
    expect(curl).toContain('"nome": "Ana Silva"')
    expect(curl).toContain('curl -X POST "https://x/api/v1/webhooks/in/t"')
    const html = htmlFormExample('https://x/w', { phone: 'telefone' })
    expect(html).toContain('name="telefone"')
    expect(html).toContain('action="https://x/w"')
  })
})

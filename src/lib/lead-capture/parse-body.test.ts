import { describe, expect, it } from 'vitest'

import { entriesToPayload, parseJsonPayload, parseLeadBody, parseUrlEncodedPayload } from './parse-body'

function req(body: string | FormData, contentType?: string) {
  return new Request('http://localhost/api/v1/webhooks/in/abc', {
    method: 'POST',
    headers: contentType ? { 'content-type': contentType } : undefined,
    body,
  })
}

describe('parseLeadBody', () => {
  it('parses application/json objects', async () => {
    const p = await parseLeadBody(req(JSON.stringify({ nome: 'Ana', lead: { telefone: '55119' } }), 'application/json'))
    expect(p).toEqual({ nome: 'Ana', lead: { telefone: '55119' } })
  })

  it('rejects JSON that is not an object', async () => {
    expect(await parseLeadBody(req('[1,2]', 'application/json'))).toBeNull()
    expect(await parseLeadBody(req('"x"', 'application/json'))).toBeNull()
    expect(await parseLeadBody(req('{not json', 'application/json'))).toBeNull()
  })

  it('parses application/x-www-form-urlencoded (what curl -d sends)', async () => {
    const p = await parseLeadBody(
      req('nome=Teste+Lead&telefone=5511988887777&email=t%40x.com', 'application/x-www-form-urlencoded'),
    )
    expect(p).toEqual({ nome: 'Teste Lead', telefone: '5511988887777', email: 't@x.com' })
  })

  it('parses multipart/form-data and drops files', async () => {
    const fd = new FormData()
    fd.append('name', 'Bia')
    fd.append('phone', '5511911112222')
    fd.append('cv', new Blob(['pdf'], { type: 'application/pdf' }), 'cv.pdf')
    const p = await parseLeadBody(req(fd))
    expect(p).toEqual({ name: 'Bia', phone: '5511911112222' })
  })

  it('falls back to JSON then urlencoded when the content-type is missing', async () => {
    expect(await parseLeadBody(req('{"phone":"5511"}'))).toEqual({ phone: '5511' })
    expect(await parseLeadBody(req('phone=5511&x=1'))).toEqual({ phone: '5511', x: '1' })
  })

  it('returns null on an empty body', async () => {
    expect(await parseLeadBody(req('', 'application/json'))).toBeNull()
    expect(await parseLeadBody(req('', 'application/x-www-form-urlencoded'))).toBeNull()
  })
})

describe('entriesToPayload', () => {
  it('collapses repeated keys and bracket arrays', () => {
    expect(
      entriesToPayload([
        ['a', '1'],
        ['a', '2'],
        ['b[]', 'x'],
        ['c', 'only'],
      ]),
    ).toEqual({ a: ['1', '2'], b: ['x'], c: 'only' })
  })
})

describe('parse helpers', () => {
  it('parseJsonPayload / parseUrlEncodedPayload edge cases', () => {
    expect(parseJsonPayload('  ')).toBeNull()
    expect(parseUrlEncodedPayload('{"a":1}')).toBeNull()
    expect(parseUrlEncodedPayload('a=1')).toEqual({ a: '1' })
  })
})

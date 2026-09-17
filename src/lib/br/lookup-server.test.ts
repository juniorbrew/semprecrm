import { beforeEach, describe, expect, it, vi } from 'vitest'

import { __resetLookupCacheForTests, lookupCep, lookupCnpj } from './lookup-server'

function res(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

const cnpjBody = {
  cnpj: '11222333000181', razao_social: 'PADARIA SOL LTDA', nome_fantasia: 'PADARIA DO SOL',
  descricao_tipo_de_logradouro: 'RUA', logradouro: 'GARIBALDI', numero: '70', complemento: '', bairro: 'CENTRO',
  municipio: 'PORTO ALEGRE', uf: 'RS', cep: '90000000', ddd_telefone_1: '5136354333', email: null,
  descricao_situacao_cadastral: 'ATIVA',
}

beforeEach(() => __resetLookupCacheForTests())

describe('lookupCnpj', () => {
  it('fetches BrasilAPI once and serves the second call from cache', async () => {
    const fetchMock = vi.fn<(url: string) => Promise<Response>>(async () => res(200, cnpjBody))
    const a = await lookupCnpj('11.222.333/0001-81', fetchMock)
    const b = await lookupCnpj('11222333000181', fetchMock)
    expect(a).toEqual({ ok: true, company: expect.objectContaining({ legalName: 'Padaria Sol LTDA', tradeName: 'Padaria do Sol' }) })
    expect(b).toEqual(a)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(String(fetchMock.mock.calls[0][0])).toBe('https://brasilapi.com.br/api/cnpj/v1/11222333000181')
  })

  it('reports not_found for a 404/400 upstream and invalid for a bad document without fetching', async () => {
    const fetchMock = vi.fn(async () => res(404, { message: 'CNPJ não encontrado' }))
    expect(await lookupCnpj('11222333000181', fetchMock)).toEqual({ ok: false, reason: 'not_found' })
    expect(await lookupCnpj('11222333000182', fetchMock)).toEqual({ ok: false, reason: 'invalid' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('reports upstream_error on network failure or 5xx and does not cache it', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce(res(503, {}))
      .mockResolvedValueOnce(res(200, cnpjBody))
    expect(await lookupCnpj('11222333000181', fetchMock)).toEqual({ ok: false, reason: 'upstream_error' })
    expect(await lookupCnpj('11222333000181', fetchMock)).toEqual({ ok: false, reason: 'upstream_error' })
    expect((await lookupCnpj('11222333000181', fetchMock)).ok).toBe(true)
  })
})

describe('lookupCep', () => {
  it('uses BrasilAPI v2 and maps it', async () => {
    const fetchMock = vi.fn(async () => res(200, { cep: '01001000', state: 'SP', city: 'São Paulo', neighborhood: 'Sé', street: 'Praça da Sé' }))
    expect(await lookupCep('01001-000', fetchMock)).toEqual({
      ok: true,
      address: { cep: '01001000', street: 'Praça da Sé', neighborhood: 'Sé', city: 'São Paulo', state: 'SP' },
    })
  })

  it('falls back to ViaCEP when BrasilAPI fails, and reports not_found when both miss', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(res(500, {}))
      .mockResolvedValueOnce(res(200, { cep: '01001-000', logradouro: 'Praça da Sé', bairro: 'Sé', localidade: 'São Paulo', uf: 'SP' }))
    expect(await lookupCep('01001000', fetchMock)).toMatchObject({ ok: true, address: { street: 'Praça da Sé' } })
    expect(String(fetchMock.mock.calls[1][0])).toBe('https://viacep.com.br/ws/01001000/json/')

    __resetLookupCacheForTests()
    const miss = vi.fn().mockResolvedValueOnce(res(404, {})).mockResolvedValueOnce(res(200, { erro: 'true' }))
    expect(await lookupCep('99999998', miss)).toEqual({ ok: false, reason: 'not_found' })
  })

  it('races both CEP providers and takes the first good answer', async () => {
    const slowBrasilApi = new Promise<Response>((resolve) => setTimeout(() => resolve(res(200, { cep: '01001000', state: 'SP', city: 'São Paulo', neighborhood: 'Sé', street: 'Praça da Sé (BrasilAPI)' })), 300))
    const fetchMock = vi.fn(async (url: string) =>
      url.includes('viacep')
        ? res(200, { cep: '01001-000', logradouro: 'Praça da Sé', bairro: 'Sé', localidade: 'São Paulo', uf: 'SP' })
        : slowBrasilApi,
    )
    const t0 = Date.now()
    const out = await lookupCep('01001000', fetchMock)
    expect(out).toMatchObject({ ok: true, address: { street: 'Praça da Sé' } })
    expect(Date.now() - t0).toBeLessThan(250)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('rejects malformed CEPs without fetching', async () => {
    const fetchMock = vi.fn()
    expect(await lookupCep('123', fetchMock)).toEqual({ ok: false, reason: 'invalid' })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

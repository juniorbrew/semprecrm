import { describe, expect, it } from 'vitest'

import {
  formatCep,
  formatPhone,
  isValidCep,
  mapBrasilApiCep,
  mapBrasilApiCnpj,
  mapViaCep,
  normalizeCep,
  normalizePhone,
  titleCasePtBr,
  validateAccountContact,
} from './lookup'

describe('cep helpers', () => {
  it('normalises, validates and masks a CEP', () => {
    expect(normalizeCep(' 01.001-000 ')).toBe('01001000')
    expect(isValidCep('01001000')).toBe(true)
    expect(isValidCep('0100100')).toBe(false)
    expect(isValidCep('00000000')).toBe(false)
    expect(formatCep('01001')).toBe('01001')
    expect(formatCep('010010')).toBe('01001-0')
    expect(formatCep('010010009')).toBe('01001-000')
  })
})

describe('phone helpers', () => {
  it('keeps digits only and masks landlines and mobiles', () => {
    expect(normalizePhone('+55 (51) 3635-4333')).toBe('5136354333')
    expect(formatPhone('5136354333')).toBe('(51) 3635-4333')
    expect(formatPhone('11912345678')).toBe('(11) 91234-5678')
    expect(formatPhone('119')).toBe('(11) 9')
    expect(formatPhone('119123456789')).toBe('(11) 91234-5678')
  })
})

describe('titleCasePtBr', () => {
  it('title-cases Receita Federal shouting while keeping connectives lower', () => {
    expect(titleCasePtBr('CAIXA ESCOLAR DA ESCOLA ESTADUAL DE ENSINO')).toBe('Caixa Escolar da Escola Estadual de Ensino')
    expect(titleCasePtBr('PADARIA SOL LTDA')).toBe('Padaria Sol LTDA')
    expect(titleCasePtBr('JOSE E MARIA ME')).toBe('Jose e Maria ME')
    expect(titleCasePtBr('')).toBe('')
    expect(titleCasePtBr('PETROLEO BRASILEIRO S A PETROBRAS')).toBe('Petroleo Brasileiro S.A. Petrobras')
    expect(titleCasePtBr('ITAU UNIBANCO S.A.')).toBe('Itau Unibanco S.A.')
    expect(titleCasePtBr('MAGAZINE LUIZA S/A')).toBe('Magazine Luiza S/A')
    expect(titleCasePtBr('IFOOD.COM AGENCIA DE RESTAURANTES ONLINE S.A.')).toBe('Ifood.com Agencia de Restaurantes Online S.A.')
    expect(titleCasePtBr('AVENIDA DOS AUTONOMISTAS')).toBe('Avenida dos Autonomistas')
  })
})

describe('mapBrasilApiCnpj', () => {
  const payload = {
    cnpj: '11222333000181',
    razao_social: 'CAIXA ESCOLAR DA ESCOLA ESTADUAL',
    nome_fantasia: 'CAIXA ESCOLA',
    descricao_tipo_de_logradouro: 'RUA',
    logradouro: 'GARIBALDI',
    numero: '070',
    complemento: 'SALA 2',
    bairro: 'VILA RICA',
    municipio: 'SAO SEBASTIAO DO CAI',
    uf: 'RS',
    cep: '95760000',
    ddd_telefone_1: '5136354333',
    ddd_telefone_2: '',
    email: 'CONTATO@EXEMPLO.COM.BR',
    descricao_situacao_cadastral: 'ATIVA',
  }

  it('maps the Receita payload to our company shape, humanised', () => {
    expect(mapBrasilApiCnpj(payload)).toEqual({
      taxId: '11222333000181',
      legalName: 'Caixa Escolar da Escola Estadual',
      tradeName: 'Caixa Escola',
      address: {
        cep: '95760000',
        street: 'Rua Garibaldi',
        number: '70',
        complement: 'Sala 2',
        neighborhood: 'Vila Rica',
        city: 'Sao Sebastiao do Cai',
        state: 'RS',
      },
      phone: '5136354333',
      email: 'contato@exemplo.com.br',
      status: 'ATIVA',
    })
  })

  it('title-cases the street as one phrase and drops a number the Receita repeated in it', () => {
    const out = mapBrasilApiCnpj({ ...payload, descricao_tipo_de_logradouro: 'AVENIDA', logradouro: 'DOS AUTONOMISTAS 1496', numero: '1496' })
    expect(out.address.street).toBe('Avenida dos Autonomistas')
    expect(out.address.number).toBe('1496')
  })

  it('tolerates missing optional fields', () => {
    const out = mapBrasilApiCnpj({ ...payload, nome_fantasia: '', email: null, ddd_telefone_1: null, numero: 'S/N', complemento: null })
    expect(out.tradeName).toBe('')
    expect(out.email).toBe('')
    expect(out.phone).toBe('')
    expect(out.address.number).toBe('S/N')
    expect(out.address.complement).toBe('')
  })
})

describe('CEP mappers', () => {
  it('maps BrasilAPI v2', () => {
    expect(
      mapBrasilApiCep({ cep: '01001000', state: 'SP', city: 'São Paulo', neighborhood: 'Sé', street: 'Praça da Sé' }),
    ).toEqual({ cep: '01001000', street: 'Praça da Sé', neighborhood: 'Sé', city: 'São Paulo', state: 'SP' })
  })

  it('maps ViaCEP and returns null for its "erro" answer', () => {
    expect(
      mapViaCep({ cep: '01001-000', logradouro: 'Praça da Sé', bairro: 'Sé', localidade: 'São Paulo', uf: 'SP' }),
    ).toEqual({ cep: '01001000', street: 'Praça da Sé', neighborhood: 'Sé', city: 'São Paulo', state: 'SP' })
    expect(mapViaCep({ erro: 'true' })).toBeNull()
  })
})

describe('validateAccountContact', () => {
  it('normalises phone, email and address, all optional', () => {
    expect(validateAccountContact({})).toEqual({ ok: true, value: { phone: null, email: null, address: null } })
    expect(
      validateAccountContact({
        phone: '(51) 3635-4333',
        email: ' Contato@Exemplo.com ',
        address: { cep: '95760-000', street: ' Rua Garibaldi ', number: '70', complement: '', neighborhood: 'Vila Rica', city: 'São Sebastião do Caí', state: 'rs' },
      }),
    ).toEqual({
      ok: true,
      value: {
        phone: '5136354333',
        email: 'contato@exemplo.com',
        address: { cep: '95760000', street: 'Rua Garibaldi', number: '70', complement: '', neighborhood: 'Vila Rica', city: 'São Sebastião do Caí', state: 'RS' },
      },
    })
  })

  it('reports invalid phone, email, cep and state', () => {
    expect(
      validateAccountContact({ phone: '123', email: 'nope', address: { cep: '123', state: 'XX' } }),
    ).toEqual({ ok: false, errors: { phone: 'invalid', email: 'invalid', cep: 'invalid', state: 'invalid' } })
  })

  it('treats an address with only blanks as absent', () => {
    expect(validateAccountContact({ address: { cep: '', street: ' ' } })).toEqual({
      ok: true,
      value: { phone: null, email: null, address: null },
    })
  })
})

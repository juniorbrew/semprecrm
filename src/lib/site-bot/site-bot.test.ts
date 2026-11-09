import { describe, expect, it } from 'vitest'

import {
  BOT_LIMITS,
  buildLeadFromAnswers,
  corsHeaders,
  defaultBotConfig,
  normalizeDomain,
  originAllowed,
  publicBotConfig,
  validateAnswers,
  validateBotConfig,
  whatsappLink,
  type BotConfig,
} from './index'
import { generateBotPublicKey, isBotPublicKey } from './key'

const FIELD = '11111111-1111-4111-8111-111111111111'

function cfg(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...(defaultBotConfig() as unknown as Record<string, unknown>), ...patch }
}

function valid(patch: Record<string, unknown> = {}): BotConfig {
  const r = validateBotConfig(cfg(patch))
  if (!r.ok) throw new Error(r.errors.join('; '))
  return r.config
}

const questions = (extra: unknown[] = []) => [
  { id: 'nome', text: 'Nome?', type: 'name', required: true },
  { id: 'fone', text: 'WhatsApp?', type: 'phone', required: true },
  ...extra,
]

function errorsOf(patch: Record<string, unknown>): string[] {
  const r = validateBotConfig(cfg(patch))
  return r.ok ? [] : r.errors
}

describe('normalizeDomain', () => {
  it('reduces URLs to a bare hostname', () => {
    expect(normalizeDomain('https://www.Loja.com.br/contato?x=1')).toBe('loja.com.br')
    expect(normalizeDomain('minhaloja.com.br')).toBe('minhaloja.com.br')
    expect(normalizeDomain('  WWW.Site.com:8080 ')).toBe('site.com')
    expect(normalizeDomain('localhost')).toBe('localhost')
  })
  it('rejects junk', () => {
    for (const bad of ['', 'sem ponto', 'a_b.com', 'x', '-a.com', '..', 42, null, 'http://', '<script>.com']) {
      expect(normalizeDomain(bad)).toBeNull()
    }
  })
})

describe('validateBotConfig', () => {
  it('accepts the default config and normalises it', () => {
    const c = valid({ domains: ['https://WWW.Loja.com.br', 'loja.com.br', 'outra.com'] })
    expect(c.domains).toEqual(['loja.com.br', 'outra.com'])
    expect(c.appearance.color).toBe('#2563eb')
  })

  it('requires exactly one name and one phone question, at most one email', () => {
    expect(errorsOf({ questions: [{ id: 'fone', text: 'x', type: 'phone', required: true }] })).toContain(
      'exactly one name question is required',
    )
    expect(errorsOf({ questions: [{ id: 'nome', text: 'x', type: 'name', required: true }] })).toContain(
      'exactly one phone question is required',
    )
    expect(
      errorsOf({
        questions: questions([
          { id: 'e1', text: 'e', type: 'email', required: false },
          { id: 'e2', text: 'e', type: 'email', required: false },
        ]),
      }),
    ).toContain('at most one email question')
  })

  it('forces name and phone to be required', () => {
    const c = valid({
      questions: [
        { id: 'nome', text: 'Nome?', type: 'name', required: false },
        { id: 'fone', text: 'Fone?', type: 'phone', required: false },
      ],
    })
    expect(c.questions.every((q) => q.required)).toBe(true)
  })

  it('limits questions to 10 and options to 2..6', () => {
    const many = questions(
      Array.from({ length: 9 }, (_, i) => ({ id: `q${i}`, text: 'x', type: 'text', required: false })),
    )
    expect(errorsOf({ questions: many })).toContain('at most 10 questions')
    const choice = (options: string[]) =>
      errorsOf({ questions: questions([{ id: 'c', text: 'x', type: 'choice', options, required: false }]) })
    expect(choice(['a'])).not.toEqual([])
    expect(choice(['1', '2', '3', '4', '5', '6', '7'])).not.toEqual([])
    expect(choice(['a', 'a'])).toContain('question 3: options must be different')
    expect(choice(['a', ''])).not.toEqual([])
    expect(choice(['a', 'b'])).toEqual([])
    expect(choice(['1', '2', '3', '4', '5', '6'])).toEqual([])
  })

  it('checks ids, types and text lengths', () => {
    expect(errorsOf({ questions: questions([{ id: 'Nome', text: 'x', type: 'text' }]) })).toContain(
      'question 3: invalid id',
    )
    expect(errorsOf({ questions: questions([{ id: 'nome', text: 'x', type: 'text' }]) })).toContain(
      'question 3: duplicate id',
    )
    expect(errorsOf({ questions: questions([{ id: 'x', text: 'x', type: 'file' }]) })).toContain(
      'question 3: invalid type',
    )
    expect(
      errorsOf({ questions: questions([{ id: 'x', text: 'a'.repeat(BOT_LIMITS.question + 1), type: 'text' }]) }),
    ).not.toEqual([])
    expect(errorsOf({ greeting: 'a'.repeat(BOT_LIMITS.greeting + 1) })).not.toEqual([])
    expect(errorsOf({ greeting: '  ' })).toContain('greeting is required')
  })

  it('requires a real custom field when the target is custom, once each', () => {
    const custom = (customFieldId?: string, id = 'c') => ({
      id,
      text: 'x',
      type: 'text',
      required: false,
      target: 'custom',
      customFieldId,
    })
    expect(errorsOf({ questions: questions([custom(undefined)]) })).toContain('question 3: pick a custom field')
    expect(errorsOf({ questions: questions([custom('not-a-uuid')]) })).toContain('question 3: pick a custom field')
    expect(errorsOf({ questions: questions([custom(FIELD)]) })).toEqual([])
    expect(errorsOf({ questions: questions([custom(FIELD), custom(FIELD, 'd')]) })).toContain(
      'each custom field can be used once',
    )
  })

  it('validates colors, side and the privacy link', () => {
    const app = (p: Record<string, unknown>) => ({ ...defaultBotConfig().appearance, ...p })
    expect(errorsOf({ appearance: app({ color: 'red' }) })).toContain('color must be #rrggbb')
    expect(errorsOf({ appearance: app({ color: '#FFF' }) })).toContain('color must be #rrggbb')
    expect(errorsOf({ appearance: app({ color: 'url(javascript:1)' }) })).toContain('color must be #rrggbb')
    expect(valid({ appearance: app({ color: '#AABBCC' }) }).appearance.color).toBe('#aabbcc')
    expect(errorsOf({ appearance: app({ side: 'top' }) })).toContain('side must be left or right')
    const lgpd = (linkUrl: string) => ({ text: 'ok', linkUrl })
    expect(errorsOf({ lgpd: lgpd('javascript:alert(1)') })).toContain('privacy link must be an https address')
    expect(errorsOf({ lgpd: lgpd('http://x.com/p') })).toContain('privacy link must be an https address')
    expect(errorsOf({ lgpd: lgpd('https://u:p@x.com/p') })).toContain('privacy link must be an https address')
    expect(errorsOf({ lgpd: lgpd('https://x.com/privacidade') })).toEqual([])
    expect(errorsOf({ lgpd: { text: '', linkUrl: '' } })).toContain('consent text is required')
  })

  it('needs a plausible WhatsApp number only when the button is on', () => {
    const end = (p: Record<string, unknown>) => ({ ...defaultBotConfig().end, ...p })
    expect(errorsOf({ end: end({ whatsappEnabled: true, whatsappNumber: '123' }) })).not.toEqual([])
    const c = valid({ end: end({ whatsappEnabled: true, whatsappNumber: '+55 (11) 98765-4321' }) })
    expect(c.end.whatsappNumber).toBe('5511987654321')
    expect(valid({ end: end({ whatsappEnabled: false, whatsappNumber: '999' }) }).end.whatsappNumber).toBe('')
  })

  it('rejects domains it cannot read and too many of them', () => {
    expect(errorsOf({ domains: ['ok.com', 'sem espaco.com'] })[0]).toMatch(/invalid domain/)
    expect(errorsOf({ domains: Array.from({ length: 11 }, (_, i) => `d${i}.com`) })).toContain('at most 10 domains')
    expect(errorsOf({ domains: 'a.com' })).toContain('domains must be a list')
  })

  it('rejects non-objects', () => {
    for (const bad of [null, [], 'x', 1]) expect(validateBotConfig(bad).ok).toBe(false)
  })

  it('stays in sync with the DB size check for a maximal config', () => {
    const big = questions(
      Array.from({ length: 8 }, (_, i) => ({
        id: `q${i}`,
        text: 'x'.repeat(BOT_LIMITS.question),
        type: 'choice',
        options: Array.from({ length: 6 }, (_, j) => `${j}`.repeat(BOT_LIMITS.option)),
        required: false,
      })),
    )
    const c = valid({ questions: big })
    expect(JSON.stringify(c).length).toBeLessThan(16 * 1024)
  })
})

describe('publicBotConfig', () => {
  it('exposes only what a visitor needs', () => {
    const c = valid({
      questions: questions([
        { id: 'c', text: 'Qual?', type: 'choice', options: ['A', 'B'], required: false, target: 'custom', customFieldId: FIELD },
      ]),
      end: { ...defaultBotConfig().end, whatsappEnabled: true, whatsappNumber: '5511987654321' },
      domains: ['loja.com.br'],
    })
    const p = publicBotConfig(c)
    const json = JSON.stringify(p)
    expect(json).not.toContain(FIELD)
    expect(json).not.toContain('5511987654321')
    expect(json).not.toContain('loja.com.br')
    expect(json).not.toContain('customFieldId')
    expect(json).not.toContain('target')
    expect(p.whatsapp).toBe(true)
    expect(p.questions[2]).toEqual({ id: 'c', text: 'Qual?', type: 'choice', options: ['A', 'B'], required: false })
    expect(Object.keys(p).sort()).toEqual(
      ['bubbleText', 'color', 'consent', 'greeting', 'name', 'questions', 'side', 'thanks', 'whatsapp'].sort(),
    )
  })
})

describe('originAllowed', () => {
  const domains = ['minhaloja.com.br']
  it('accepts the exact host and the www variant over https', () => {
    expect(originAllowed('https://minhaloja.com.br', domains)).toBe(true)
    expect(originAllowed('https://www.minhaloja.com.br', domains)).toBe(true)
    expect(originAllowed('https://WWW.MinhaLoja.com.br', domains)).toBe(true)
  })
  it('refuses everything else', () => {
    for (const o of [
      'http://minhaloja.com.br',
      'https://evil.com',
      'https://minhaloja.com.br.evil.com',
      'https://evilminhaloja.com.br',
      'https://sub.minhaloja.com.br',
      'https://minhaloja.com.br/path',
      'https://minhaloja.com.br@evil.com',
      'null',
      '',
      null,
      undefined,
      'file://x',
    ]) {
      expect(originAllowed(o as string, domains)).toBe(false)
    }
  })
  it('refuses all origins when no domain is registered', () => {
    expect(originAllowed('https://minhaloja.com.br', [])).toBe(false)
    expect(originAllowed('http://localhost:3000', [])).toBe(false)
  })
  it('allows http localhost only when the bot lists localhost', () => {
    expect(originAllowed('http://localhost:3110', ['localhost'])).toBe(true)
    expect(originAllowed('http://localhost:3110', domains)).toBe(false)
    expect(originAllowed('http://127.0.0.1:3110', ['localhost'])).toBe(false)
    expect(originAllowed('http://minhaloja.com.br', ['minhaloja.com.br'])).toBe(false)
  })
  it('echoes the origin in the CORS headers and varies on it', () => {
    const h = corsHeaders('https://minhaloja.com.br')
    expect(h['Access-Control-Allow-Origin']).toBe('https://minhaloja.com.br')
    expect(h.Vary).toBe('Origin')
    expect(Object.values(h)).not.toContain('*')
  })
})

describe('validateAnswers', () => {
  const config = valid({
    questions: questions([
      { id: 'mail', text: 'Email?', type: 'email', required: false },
      { id: 'cor', text: 'Cor?', type: 'choice', options: ['Azul', 'Verde'], required: true },
      { id: 'obs', text: 'Obs?', type: 'text', required: false },
    ]),
  })
  const base = { nome: 'Ana', fone: '(11) 98765-4321', cor: 'Azul' }

  it('cleans and normalises a good submission', () => {
    const r = validateAnswers(config, { ...base, mail: 'ana@exemplo.com', obs: '  oi\n\ttudo  bem  ' })
    expect(r).toEqual({
      ok: true,
      answers: { nome: 'Ana', fone: '5511987654321', mail: 'ana@exemplo.com', cor: 'Azul', obs: 'oi tudo bem' },
    })
  })
  it('skips empty optional answers', () => {
    const r = validateAnswers(config, { ...base, mail: '  ', obs: '' })
    expect(r.ok && Object.keys(r.answers).sort()).toEqual(['cor', 'fone', 'nome'])
  })
  it('requires required answers', () => {
    expect(validateAnswers(config, { nome: 'Ana', fone: '11987654321' })).toMatchObject({
      ok: false,
      error: 'missing_answer',
      questionId: 'cor',
    })
    expect(validateAnswers(config, { ...base, nome: '   ' })).toMatchObject({ error: 'missing_answer', questionId: 'nome' })
  })
  it('rejects invalid phone, email and option values', () => {
    expect(validateAnswers(config, { ...base, fone: '123' })).toMatchObject({ error: 'invalid_phone', questionId: 'fone' })
    expect(validateAnswers(config, { ...base, fone: 'abc' })).toMatchObject({ error: 'invalid_phone' })
    for (const mail of ['ana', 'ana@', 'a@b', 'a b@c.com', '<x>@y.com', 'a@b.c']) {
      expect(validateAnswers(config, { ...base, mail })).toMatchObject({ error: 'invalid_email' })
    }
    expect(validateAnswers(config, { ...base, cor: 'Vermelho' })).toMatchObject({ error: 'invalid_option' })
    expect(validateAnswers(config, { ...base, cor: 'azul' })).toMatchObject({ error: 'invalid_option' })
  })
  it('rejects unknown questions and non-text values', () => {
    expect(validateAnswers(config, { ...base, pipeline_id: 'x' })).toMatchObject({ error: 'unknown_question' })
    expect(validateAnswers(config, { ...base, nome: 42 })).toMatchObject({ error: 'invalid_answers' })
    expect(validateAnswers(config, { ...base, obs: ['a'] })).toMatchObject({ error: 'invalid_answers' })
    for (const bad of [null, [], 'x', 5]) expect(validateAnswers(config, bad)).toMatchObject({ error: 'invalid_answers' })
  })
  it('rejects names that carry a link, a domain, an address or a long number', () => {
    for (const nome of ['http://x.co', 'www.golpe.com', 'ana@x.com', 'Ligue 11999990000', 'veja bit.ly/abc', 'ganhe.xyz agora', 'Ana 12345678']) {
      expect(validateAnswers(config, { ...base, nome }), nome).toMatchObject({ ok: false, error: 'invalid_name', questionId: 'nome' })
    }
    for (const nome of ['Ana Souza', "D'Ávila Júnior", 'Ana.Coelho', 'José 2º', 'Maria (Mari)']) {
      expect(validateAnswers(config, { ...base, nome }).ok, nome).toBe(true)
    }
  })

  it('caps every answer at 500 characters', () => {
    expect(validateAnswers(config, { ...base, obs: 'a'.repeat(500) }).ok).toBe(true)
    expect(validateAnswers(config, { ...base, obs: 'a'.repeat(501) })).toMatchObject({ error: 'answer_too_long' })
    expect(validateAnswers(config, { ...base, nome: 'a'.repeat(81) })).toMatchObject({ error: 'answer_too_long' })
  })
  it('keeps markup as inert text', () => {
    const r = validateAnswers(config, { ...base, obs: '<img src=x onerror=alert(1)>' })
    expect(r.ok && r.answers.obs).toBe('<img src=x onerror=alert(1)>')
  })
})

describe('buildLeadFromAnswers', () => {
  const config = valid({
    questions: questions([
      { id: 'mail', text: 'Email?', type: 'email', required: false },
      { id: 'cor', text: 'Cor?', type: 'choice', options: ['Azul', 'Verde'], required: true, target: 'custom', customFieldId: FIELD },
      { id: 'obs', text: 'Observação?', type: 'text', required: false },
    ]),
  })
  const consent = { at: '2026-11-09T12:00:00.000Z', text: 'Concordo em ser contatado.', linkUrl: 'https://loja.com.br/privacidade' }
  const answers = { nome: 'Ana', fone: '5511987654321', mail: 'ana@exemplo.com', cor: 'Azul', obs: 'Quero orçamento' }

  it('maps answers to the payload, the field map and the deal note', () => {
    const lead = buildLeadFromAnswers(config, answers, consent)
    expect(lead.payload).toMatchObject({
      name: 'Ana',
      phone: '5511987654321',
      email: 'ana@exemplo.com',
      a_cor: 'Azul',
      a_obs: 'Quero orçamento',
      _consent: { at: consent.at, text: 'Concordo em ser contatado.', link: 'https://loja.com.br/privacidade' },
    })
    expect(lead.fieldMap).toEqual({ name: 'name', phone: 'phone', email: 'email', custom: { [FIELD]: 'a_cor' } })
    expect(lead.dealNotes).toBe('Respostas do robô do site\nEmail?: ana@exemplo.com\nCor?: Azul\nObservação?: Quero orçamento')
    expect(lead.name).toBe('Ana')
  })
  it('leaves out unanswered optional questions', () => {
    const lead = buildLeadFromAnswers(config, { nome: 'Ana', fone: '5511987654321', cor: 'Verde' }, consent)
    expect(lead.payload).not.toHaveProperty('email')
    expect(lead.payload).not.toHaveProperty('a_obs')
    expect(lead.dealNotes).toBe('Respostas do robô do site\nCor?: Verde')
  })
  it('takes custom field ids from the config, never from answers', () => {
    const lead = buildLeadFromAnswers(config, { ...answers, [FIELD]: 'hack' } as Record<string, string>, consent)
    expect(Object.keys(lead.fieldMap.custom ?? {})).toEqual([FIELD])
    expect(lead.fieldMap.custom?.[FIELD]).toBe('a_cor')
  })
})

describe('whatsappLink', () => {
  it('builds a wa.me link with digits only and an encoded text', () => {
    expect(whatsappLink('+55 (11) 98765-4321', 'Olá! Sou {nome}, vim pelo site.', 'Ana')).toBe(
      `https://wa.me/5511987654321?text=${encodeURIComponent('Olá! Sou Ana, vim pelo site.')}`,
    )
  })
  it('encodes hostile names instead of passing them through', () => {
    const url = whatsappLink('5511987654321', 'Oi {nome}', 'A&b=c#d?e <x>\n')!
    expect(url.startsWith('https://wa.me/5511987654321?text=')).toBe(true)
    const query = url.slice(url.indexOf('?') + 1)
    expect(query.split('&')).toHaveLength(1)
    expect(url).not.toMatch(/[<>#\s]/)
    expect(new URL(url).searchParams.get('text')).toBe('Oi A&b=c#d?e <x>')
  })
  it('replaces every {nome} and drops the text when the template is empty', () => {
    expect(new URL(whatsappLink('5511987654321', '{nome} {NOME}', 'Ana')!).searchParams.get('text')).toBe('Ana Ana')
    expect(whatsappLink('5511987654321', '', 'Ana')).toBe('https://wa.me/5511987654321')
  })
  it('returns null for an unusable number', () => {
    expect(whatsappLink('', 'x', 'Ana')).toBeNull()
    expect(whatsappLink('123', 'x', 'Ana')).toBeNull()
    expect(whatsappLink('0551198765432', 'x', 'Ana')).toBeNull()
  })
})

describe('public key', () => {
  it('is 32 hex chars and unique', () => {
    const a = generateBotPublicKey()
    expect(isBotPublicKey(a)).toBe(true)
    expect(a).not.toBe(generateBotPublicKey())
    expect(isBotPublicKey('A'.repeat(32))).toBe(false)
    expect(isBotPublicKey(undefined)).toBe(false)
  })
})

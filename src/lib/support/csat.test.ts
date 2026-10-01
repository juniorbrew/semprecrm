import { describe, expect, it } from 'vitest'

import {
  CSAT_COMMENT_PROMPT,
  CSAT_DEFAULTS,
  csatSkipReason,
  hasRequestWords,
  isPoliteReply,
  judgeComment,
  latestCsatScore,
  parseScoreWithComment,
  isCommentDecline,
  parseCsatScore,
  parseCsatSettings,
  thanksText,
  type CsatEligibilityInput,
} from './csat'

describe('parseCsatScore', () => {
  it.each([
    ['1', 1],
    ['5', 5],
    [' 3 ', 3],
    ['4.', 4],
    ['5!', 5],
    ['nota 4', 4],
    ['Nota 2', 2],
    ['5 estrelas', 5],
    ['1 estrela', 1],
    ['4/5', 4],
    ['4 / 5', 4],
    ['três', 3],
    ['TRES', 3],
    ['cinco', 5],
    ['um', 1],
    ['quatro estrelas', 4],
    ['⭐⭐⭐', 3],
    ['⭐', 1],
    ['👍', 5],
    ['👍🏽', 5],
    ['👎', 1],
  ])('%j is %i', (text, score) => {
    expect(parseCsatScore(text)).toBe(score)
  })

  it.each([
    [''],
    ['   '],
    ['0'],
    ['6'],
    ['10'],
    ['15'],
    ['4 5'],
    ['nota'],
    ['bom'],
    ['não sei'],
    ['5 mas demorou muito'],
    ['quanto custa o frete?'],
    ['obrigado'],
    ['⭐⭐⭐⭐⭐⭐'],
    ['👍 e 👎'],
    ['👍👍'],
    ['uma'],
    ['Uma estrela'],
    ['123456789012345678901234567890'],
  ])('%j is not a score (stays a normal message)', (text) => {
    expect(parseCsatScore(text)).toBeNull()
  })

  it('null / undefined are not scores', () => {
    expect(parseCsatScore(null)).toBeNull()
    expect(parseCsatScore(undefined)).toBeNull()
  })
})

describe('polite replies, score + words and the comment verdict', () => {
  it.each(['obrigado', 'Obrigada!', 'ótimo', 'valeu', '10', 'nota 10', '👍👍', 'muito obrigado', '🙏'])('%j is polite', (t) => {
    expect(isPoliteReply(t)).toBe(true)
  })
  it.each(['5', '👍', 'obrigado pelo atendimento, mas meu boleto não chegou', 'quero cancelar', '', 'quando chega?'])('%j is not polite', (t) => {
    expect(isPoliteReply(t)).toBe(false)
  })
  it('parseScoreWithComment reads a score followed by words', () => {
    expect(parseScoreWithComment('5 mas demorou')).toEqual({ score: 5, comment: 'mas demorou' })
    expect(parseScoreWithComment('nota 4, bom atendimento')).toEqual({ score: 4, comment: 'bom atendimento' })
    expect(parseScoreWithComment('5 estrelas')).toBeNull()
    expect(parseScoreWithComment('10 coisas')).toBeNull()
    expect(parseScoreWithComment('5 e o meu pedido?')).toBeNull()
    expect(parseScoreWithComment('5')).toBeNull()
  })
  it('request words', () => {
    for (const t of ['preciso da segunda via', 'quero cancelar', 'meu pedido', 'não funciona', 'erro 500', 'boleto', 'nota fiscal', 'suporte']) expect(hasRequestWords(t)).toBe(true)
    for (const t of ['atendimento rápido', 'a Joana foi ótima']) expect(hasRequestWords(t)).toBe(false)
  })
  it('judgeComment: when in doubt it flows', () => {
    expect(judgeComment('foi rápido', 5)).toBe('consume')
    expect(judgeComment('não', 5)).toBe('decline')
    expect(judgeComment('5', 4)).toBe('decline')
    expect(judgeComment('quero cancelar', 5)).toBe('record')
    expect(judgeComment('demorou', 2)).toBe('record')
    expect(judgeComment('e o prazo?', 5)).toBe('flow')
    expect(judgeComment('a'.repeat(201), 5)).toBe('flow')
    expect(judgeComment('', 5)).toBe('flow')
  })
})

describe('comment reading', () => {
  it.each(['não', 'Não', 'nao', 'n', 'pular', 'sem comentário', 'não obrigado', 'obrigado', 'nada', 'ok'])('%j declines', (t) => {
    expect(isCommentDecline(t)).toBe(true)
  })
  it('a real comment is not a decline', () => {
    expect(isCommentDecline('não gostei da demora')).toBe(false)
  })
})

describe('parseCsatSettings', () => {
  it('no row = off, with the pt-BR defaults', () => {
    expect(parseCsatSettings(null)).toEqual(CSAT_DEFAULTS)
    expect(CSAT_DEFAULTS.enabled).toBe(false)
    expect(CSAT_DEFAULTS.delay_minutes).toBe(5)
    expect(CSAT_DEFAULTS.cooldown_days).toBe(7)
    expect(CSAT_DEFAULTS.skip_resolutions).toEqual(['not_applicable', 'duplicate', 'expired'])
  })
  it('keeps valid values, repairs the bad ones', () => {
    const s = parseCsatSettings({ enabled: true, scale: 'thumbs', delay_minutes: 99999, cooldown_days: -1, message_text: '  ', ask_comment: false })
    expect(s).toMatchObject({ enabled: true, scale: 'thumbs', delay_minutes: 5, cooldown_days: 7, ask_comment: false })
    expect(s.message_text).toContain('👍')
  })
})

describe('thanksText', () => {
  it('adds the comment question only when asked for', () => {
    expect(thanksText({ ...CSAT_DEFAULTS, ask_comment: false })).toBe('Obrigado pela sua avaliação!')
    expect(thanksText({ ...CSAT_DEFAULTS, ask_comment: true })).toBe(`Obrigado pela sua avaliação!\n\n${CSAT_COMMENT_PROMPT}`)
    expect(thanksText({ ...CSAT_DEFAULTS, thanks_text: '', ask_comment: true })).toBe(CSAT_COMMENT_PROMPT)
  })
})

describe('csatSkipReason', () => {
  const NOW = new Date('2026-09-30T12:00:00Z')
  type Over = Partial<Omit<CsatEligibilityInput, 'conversation' | 'contact'>> & {
    conversation?: Partial<CsatEligibilityInput['conversation']>
    contact?: Partial<CsatEligibilityInput['contact']>
  }
  const base = (over: Over = {}): CsatEligibilityInput => ({
    settings: { ...CSAT_DEFAULTS, enabled: true },
    jobServiceCount: 1,
    lastSentAt: null,
    now: NOW,
    ...over,
    conversation: {
      status: 'closed',
      service_count: 1,
      resolution: 'resolved',
      category_id: null,
      channel: 'official',
      last_customer_message_at: '2026-09-30T10:00:00Z',
      ...over.conversation,
    },
    contact: { opted_out_at: null, anonymized_at: null, phone: '5511999990000', ...over.contact },
  })

  it('an ordinary resolved conversation is eligible', () => {
    expect(csatSkipReason(base())).toBeNull()
  })
  it('reopened before the send, or reopened and resolved again (another attendance)', () => {
    expect(csatSkipReason(base({ conversation: { status: 'open' } }))).toBe('reopened')
    expect(csatSkipReason(base({ conversation: { service_count: 2 } }))).toBe('reopened')
  })
  it('turned off in the meantime', () => {
    expect(csatSkipReason(base({ settings: { ...CSAT_DEFAULTS, enabled: false } }))).toBe('disabled')
  })
  it('skips the excluded resolutions, not "resolved" or "closed by customer"', () => {
    for (const resolution of ['not_applicable', 'duplicate', 'expired']) {
      expect(csatSkipReason(base({ conversation: { resolution } }))).toBe('resolution_excluded')
    }
    for (const resolution of ['resolved', 'closed_by_customer']) {
      expect(csatSkipReason(base({ conversation: { resolution } }))).toBeNull()
    }
  })
  it('only_categories limits the survey to those categories', () => {
    const settings = { ...CSAT_DEFAULTS, enabled: true, only_categories: ['cat-1'] }
    expect(csatSkipReason(base({ settings, conversation: { category_id: 'cat-2' } }))).toBe('category_excluded')
    expect(csatSkipReason(base({ settings, conversation: { category_id: null } }))).toBe('category_excluded')
    expect(csatSkipReason(base({ settings, conversation: { category_id: 'cat-1' } }))).toBeNull()
  })
  it('never surveys an opted-out or anonymised contact, or one without a phone', () => {
    expect(csatSkipReason(base({ contact: { opted_out_at: '2026-01-01T00:00:00Z' } }))).toBe('opted_out')
    expect(csatSkipReason(base({ contact: { anonymized_at: '2026-01-01T00:00:00Z' } }))).toBe('opted_out')
    expect(csatSkipReason(base({ contact: { phone: null } }))).toBe('no_phone')
  })
  it('needs a message from the customer', () => {
    expect(csatSkipReason(base({ conversation: { last_customer_message_at: null } }))).toBe('no_customer_message')
  })
  it('cooldown: not again within cooldown_days of the last survey sent to this contact', () => {
    expect(csatSkipReason(base({ lastSentAt: '2026-09-25T12:00:00Z' }))).toBe('cooldown')
    expect(csatSkipReason(base({ lastSentAt: '2026-09-22T11:59:00Z' }))).toBeNull()
    expect(csatSkipReason(base({ lastSentAt: '2026-09-29T12:00:00Z', settings: { ...CSAT_DEFAULTS, enabled: true, cooldown_days: 0 } }))).toBeNull()
  })
  it('official channel: only inside the 24 h window; QR has none', () => {
    const old = '2026-09-29T11:00:00Z'
    expect(csatSkipReason(base({ conversation: { last_customer_message_at: old } }))).toBe('window_closed')
    expect(csatSkipReason(base({ conversation: { last_customer_message_at: old, channel: 'qr' } }))).toBeNull()
    expect(csatSkipReason(base({ conversation: { last_customer_message_at: '2026-09-29T12:00:01Z' } }))).toBeNull()
  })
})

describe('latestCsatScore', () => {
  it('reads the newest csat_answered event', () => {
    expect(latestCsatScore([])).toBeNull()
    expect(latestCsatScore([{ event_type: 'status_changed' }])).toBeNull()
    expect(
      latestCsatScore([
        { event_type: 'csat_answered', payload: { score: 2 }, created_at: '2026-09-30T10:00:00Z' },
        { event_type: 'csat_answered', payload: { score: 5 }, created_at: '2026-09-30T11:00:00Z' },
        { event_type: 'csat_sent', payload: {}, created_at: '2026-09-30T12:00:00Z' },
      ]),
    ).toBe(5)
  })
  it('ignores a malformed score', () => {
    expect(latestCsatScore([{ event_type: 'csat_answered', payload: { score: 9 } }])).toBeNull()
    expect(latestCsatScore([{ event_type: 'csat_answered', payload: null }])).toBeNull()
  })
})

describe('csatSkipReason: attended, recent, still closed (D5-D7)', () => {
  const NOW = new Date('2026-09-30T12:00:00Z')
  const input = (conv: Partial<CsatEligibilityInput['conversation']> = {}, over: Partial<CsatEligibilityInput> = {}): CsatEligibilityInput => ({
    settings: { ...CSAT_DEFAULTS, enabled: true },
    jobServiceCount: 1,
    lastSentAt: null,
    now: NOW,
    conversation: {
      status: 'closed',
      service_count: 1,
      resolution: 'resolved',
      category_id: null,
      channel: 'official',
      last_customer_message_at: '2026-09-30T10:00:00Z',
      last_agent_message_at: '2026-09-30T10:05:00Z',
      resolved_at: '2026-09-30T11:55:00Z',
      ...conv,
    },
    contact: { opted_out_at: null, anonymized_at: null, phone: '5511999990000' },
    ...over,
  })

  it('nobody answered: no survey', () => {
    expect(csatSkipReason(input({ last_agent_message_at: null }))).toBe('no_agent_message')
    expect(csatSkipReason(input({ last_agent_message_at: '2026-09-30T10:05:00Z' }))).toBeNull()
  })
  it('the customer wrote too long before the close (default 72 h): stale', () => {
    expect(csatSkipReason(input({ last_customer_message_at: '2026-09-27T11:00:00Z' }))).toBe('stale')
    expect(csatSkipReason(input({ last_customer_message_at: '2026-09-27T11:00:00Z', channel: 'qr' }))).toBe('stale')
    expect(csatSkipReason(input({ last_customer_message_at: '2026-09-28T12:00:00Z', channel: 'qr' }))).toBeNull()
    const long = { ...CSAT_DEFAULTS, enabled: true, max_age_hours: 200 }
    expect(csatSkipReason(input({ last_customer_message_at: '2026-09-27T11:00:00Z', channel: 'qr' }, { settings: long }))).toBeNull()
  })
  it('the contact wrote again before the send: a live conversation wins', () => {
    expect(csatSkipReason(input({}, { hasActiveConversation: true }))).toBe('contact_active')
  })
  it('the Meta window follows the contact\'s newest customer message, not the surveyed conversation', () => {
    expect(csatSkipReason(input({ last_customer_message_at: '2026-09-29T09:00:00Z', resolved_at: '2026-09-29T10:00:00Z' }, { contactLastCustomerAt: '2026-09-30T11:00:00Z' }))).toBeNull()
    expect(csatSkipReason(input({}, { contactLastCustomerAt: '2026-09-29T11:00:00Z' }))).toBe('window_closed')
  })
})

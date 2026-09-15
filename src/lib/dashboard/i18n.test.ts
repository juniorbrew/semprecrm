import { describe, expect, it } from 'vitest'
import {
  activityText,
  dealsCount,
  deltaVsYesterday,
  directionCount,
  dowShort,
  minutesAxisLabel,
  minutesLabel,
  openDealsCount,
  rangeLabel,
  relativeTime,
  showingLabel,
  targetLabel,
} from './i18n'
import type { ActivityItem } from './types'

describe('rangeLabel', () => {
  it('localises the range toggle', () => {
    expect(rangeLabel(7, 'pt-BR')).toBe('7 dias')
    expect(rangeLabel(90, 'en-US')).toBe('90 days')
  })
})

describe('counts', () => {
  it('pluralises deals in both languages', () => {
    expect(dealsCount(1, 'pt-BR')).toBe('1 negócio')
    expect(dealsCount(3, 'pt-BR')).toBe('3 negócios')
    expect(dealsCount(1, 'en-US')).toBe('1 deal')
    expect(dealsCount(3, 'en-US')).toBe('3 deals')
  })

  it('pluralises open deals', () => {
    expect(openDealsCount(1, 'pt-BR')).toBe('1 negócio aberto')
    expect(openDealsCount(5, 'pt-BR')).toBe('5 negócios abertos')
    expect(openDealsCount(5, 'en-US')).toBe('5 open deals')
  })

  it('formats direction counts for the line-chart tooltip', () => {
    expect(directionCount(3, 'incoming', 'pt-BR')).toBe('3 recebidas')
    expect(directionCount(2, 'outgoing', 'en-US')).toBe('2 outgoing')
  })
})

describe('deltaVsYesterday', () => {
  it('keeps the sign and stays short', () => {
    expect(deltaVsYesterday(3, 'pt-BR')).toBe('+3 vs. ontem')
    expect(deltaVsYesterday(-2, 'pt-BR')).toBe('-2 vs. ontem')
    expect(deltaVsYesterday(0, 'pt-BR')).toBe('Igual a ontem')
    expect(deltaVsYesterday(0, 'en-US')).toBe('Same as yesterday')
  })
})

describe('relativeTime', () => {
  const now = new Date('2026-09-12T12:00:00Z').getTime()
  const at = (secAgo: number) => new Date(now - secAgo * 1000).toISOString()

  it('renders pt-BR relative times with the "há" form', () => {
    expect(relativeTime(at(20), 'pt-BR', now)).toBe('agora')
    expect(relativeTime(at(4 * 60), 'pt-BR', now)).toBe('há 4 min')
    expect(relativeTime(at(3600), 'pt-BR', now)).toBe('há 1 h')
    expect(relativeTime(at(2 * 86400), 'pt-BR', now)).toBe('há 2 d')
  })

  it('renders English relative times', () => {
    expect(relativeTime(at(20), 'en-US', now)).toBe('just now')
    expect(relativeTime(at(4 * 60), 'en-US', now)).toBe('4m ago')
    expect(relativeTime(at(5 * 3600), 'en-US', now)).toBe('5h ago')
  })

  it('returns an empty string for invalid dates', () => {
    expect(relativeTime('not-a-date', 'pt-BR', now)).toBe('')
  })
})

describe('response-time labels', () => {
  it('formats header figures with locale decimals', () => {
    expect(minutesLabel(null, 'pt-BR')).toBe('—')
    expect(minutesLabel(0.5, 'pt-BR')).toBe('30 s')
    expect(minutesLabel(4.25, 'pt-BR')).toBe('4,3 min')
    expect(minutesLabel(90, 'pt-BR')).toBe('1,5 h')
    expect(minutesLabel(4.25, 'en-US')).toBe('4.3m')
  })

  it('drops the trailing .0 on axis ticks', () => {
    expect(minutesAxisLabel(12, 'pt-BR')).toBe('12 min')
    expect(minutesAxisLabel(2.5, 'pt-BR')).toBe('2,5 min')
    expect(minutesAxisLabel(12, 'en-US')).toBe('12m')
  })

  it('localises the target pill and weekday axis', () => {
    expect(targetLabel(5, 'pt-BR')).toBe('meta 5 min')
    expect(targetLabel(5, 'en-US')).toBe('target 5m')
    expect(dowShort('pt-BR')[0]).toBe('seg')
    expect(dowShort('en-US')[6]).toBe('Sun')
  })
})

describe('showingLabel', () => {
  it('localises the feed footer', () => {
    expect(showingLabel(5, 43, false, 'pt-BR')).toBe('Exibindo 5 de 43')
    expect(showingLabel(50, 50, true, 'pt-BR')).toBe('Exibindo 50 de 50+')
    expect(showingLabel(5, 43, false, 'en-US')).toBe('Showing 5 of 43')
  })
})

describe('activityText', () => {
  const base = { id: 'x', at: '2026-09-12T12:00:00Z', text: 'fallback' } as const

  it('renders each event type in pt-BR', () => {
    const items: ActivityItem[] = [
      { ...base, kind: 'message', event: { type: 'message', who: 'Mariana Souza' } },
      { ...base, kind: 'message', event: { type: 'message', who: null } },
      { ...base, kind: 'contact', event: { type: 'contact', who: '+55 11 9' } },
      { ...base, kind: 'deal', event: { type: 'deal', title: 'Mesa Toscana', stage: 'Orçamento enviado' } },
      { ...base, kind: 'deal', event: { type: 'deal', title: 'Mesa', stage: null } },
      { ...base, kind: 'broadcast', event: { type: 'broadcast', name: 'Promo', status: 'sent', recipients: 1 } },
      { ...base, kind: 'broadcast', event: { type: 'broadcast', name: 'Promo', status: 'draft', recipients: 12 } },
      { ...base, kind: 'automation', event: { type: 'automation', name: 'Boas-vindas', who: 'Ana', failed: false } },
      { ...base, kind: 'automation', event: { type: 'automation', name: null, who: null, failed: true } },
    ]
    expect(items.map((i) => activityText(i, 'pt-BR'))).toEqual([
      'Nova mensagem de Mariana Souza',
      'Nova mensagem de Desconhecido',
      'Novo contato: +55 11 9',
      'Negócio “Mesa Toscana” em Orçamento enviado',
      'Negócio “Mesa” atualizado',
      'Disparo “Promo” enviado para 1 contato',
      'Disparo “Promo” rascunho (12 destinatários)',
      'Automação “Boas-vindas” acionada para Ana',
      'Automação “Automação” falhou para um contato',
    ])
  })

  it('renders English and falls back to the pre-formatted text', () => {
    expect(
      activityText(
        { ...base, kind: 'deal', event: { type: 'deal', title: 'Mesa', stage: 'Sent' } },
        'en-US',
      ),
    ).toBe('Deal "Mesa" in Sent')
    expect(activityText({ ...base, kind: 'deal' }, 'pt-BR')).toBe('fallback')
  })
})

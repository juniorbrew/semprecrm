import { describe, expect, it } from 'vitest'

import {
  DEFAULT_ACCOUNT_PREFERENCES,
  mergeAccountPreferences,
  normalizeOptOutKeyword,
  parseAccountPreferences,
} from './account-preferences'

describe('parseAccountPreferences', () => {
  it('returns the defaults for null / non-object input', () => {
    expect(parseAccountPreferences(null)).toEqual(DEFAULT_ACCOUNT_PREFERENCES)
    expect(parseAccountPreferences(undefined)).toEqual(DEFAULT_ACCOUNT_PREFERENCES)
    expect(parseAccountPreferences('x')).toEqual(DEFAULT_ACCOUNT_PREFERENCES)
    expect(parseAccountPreferences([1])).toEqual(DEFAULT_ACCOUNT_PREFERENCES)
    expect(parseAccountPreferences({})).toEqual(DEFAULT_ACCOUNT_PREFERENCES)
  })

  it('keeps valid values', () => {
    expect(
      parseAccountPreferences({
        inbox_sla_minutes: 30,
        cooling_hours: 48,
        opt_out_keywords: ['pare', 'stop'],
      }),
    ).toEqual({ inbox_sla_minutes: 30, cooling_hours: 48, opt_out_keywords: ['pare', 'stop'] })
  })

  it('accepts numeric strings and falls back per key on bad values', () => {
    const p = parseAccountPreferences({
      inbox_sla_minutes: '45',
      cooling_hours: -3,
      opt_out_keywords: 'parar',
    })
    expect(p.inbox_sla_minutes).toBe(45)
    expect(p.cooling_hours).toBe(DEFAULT_ACCOUNT_PREFERENCES.cooling_hours)
    expect(p.opt_out_keywords).toEqual(DEFAULT_ACCOUNT_PREFERENCES.opt_out_keywords)
  })

  it('rejects out-of-range numbers', () => {
    expect(parseAccountPreferences({ inbox_sla_minutes: 0 }).inbox_sla_minutes).toBe(15)
    expect(parseAccountPreferences({ inbox_sla_minutes: 100000 }).inbox_sla_minutes).toBe(15)
    expect(parseAccountPreferences({ cooling_hours: Infinity }).cooling_hours).toBe(24)
  })

  it('normalises, dedupes and drops empty keywords; honours an empty list', () => {
    expect(
      parseAccountPreferences({ opt_out_keywords: [' PARAR ', 'Não', 'nao', '', 3, 'sair'] })
        .opt_out_keywords,
    ).toEqual(['parar', 'nao', 'sair'])
    expect(parseAccountPreferences({ opt_out_keywords: [] }).opt_out_keywords).toEqual([])
  })

  it('returns a fresh keyword array each time (no shared default mutation)', () => {
    const a = parseAccountPreferences({})
    a.opt_out_keywords.push('x')
    expect(parseAccountPreferences({}).opt_out_keywords).toEqual(
      DEFAULT_ACCOUNT_PREFERENCES.opt_out_keywords,
    )
  })
})

describe('normalizeOptOutKeyword', () => {
  it('strips accents, lower-cases and trims', () => {
    expect(normalizeOptOutKeyword('  Cancelar ')).toBe('cancelar')
    expect(normalizeOptOutKeyword('NÃO')).toBe('nao')
    expect(normalizeOptOutKeyword('')).toBeNull()
    expect(normalizeOptOutKeyword(12)).toBeNull()
  })
})

describe('mergeAccountPreferences', () => {
  it('keeps unknown keys and only overwrites what the patch sets', () => {
    const merged = mergeAccountPreferences(
      { theme_hint: 'x', inbox_sla_minutes: 10, cooling_hours: 12 },
      { inbox_sla_minutes: 20 },
    )
    expect(merged).toEqual({ theme_hint: 'x', inbox_sla_minutes: 20, cooling_hours: 12 })
  })

  it('validates patched values through the parser', () => {
    const merged = mergeAccountPreferences({}, {
      inbox_sla_minutes: -1,
      opt_out_keywords: ['Sair', 'sair'],
    })
    expect(merged.inbox_sla_minutes).toBe(15)
    expect(merged.opt_out_keywords).toEqual(['sair'])
  })
})

import { describe, expect, it } from 'vitest'

import { isOptOutMessage, normalizeOptOutText } from './opt-out'

const KEYWORDS = ['parar', 'sair', 'stop', 'cancelar']

describe('isOptOutMessage', () => {
  it('matches the whole message ignoring case, accents and punctuation', () => {
    expect(isOptOutMessage('PARAR', KEYWORDS)).toBe(true)
    expect(isOptOutMessage('  parar!!! ', KEYWORDS)).toBe(true)
    expect(isOptOutMessage('Sair.', KEYWORDS)).toBe(true)
    expect(isOptOutMessage('"STOP"', KEYWORDS)).toBe(true)
    expect(isOptOutMessage('Cancelar 🙏', KEYWORDS)).toBe(true)
  })

  it('handles accented keywords on either side', () => {
    expect(isOptOutMessage('NÃO', ['não'])).toBe(true)
    expect(isOptOutMessage('nao', ['não'])).toBe(true)
    expect(isOptOutMessage('não', ['nao'])).toBe(true)
  })

  it('does not match a sentence that merely contains the word', () => {
    expect(isOptOutMessage('quero parar de receber', KEYWORDS)).toBe(false)
    expect(isOptOutMessage('parar agora', KEYWORDS)).toBe(false)
    expect(isOptOutMessage('stop it', KEYWORDS)).toBe(false)
  })

  it('supports multi-word keywords with collapsed whitespace', () => {
    expect(isOptOutMessage('Não  quero   mais', ['nao quero mais'])).toBe(true)
  })

  it('returns false for empty input or no keywords', () => {
    expect(isOptOutMessage('', KEYWORDS)).toBe(false)
    expect(isOptOutMessage(null, KEYWORDS)).toBe(false)
    expect(isOptOutMessage(undefined, KEYWORDS)).toBe(false)
    expect(isOptOutMessage('parar', [])).toBe(false)
    expect(isOptOutMessage('!!!', KEYWORDS)).toBe(false)
  })
})

describe('normalizeOptOutText', () => {
  it('strips accents and punctuation', () => {
    expect(normalizeOptOutText('  Olá, Mundo!  ')).toBe('ola mundo')
    expect(normalizeOptOutText('PARAR...')).toBe('parar')
  })
})

import { describe, expect, it } from 'vitest'

import { cleanAgentName, withAgentName } from './agent-name'

describe('withAgentName', () => {
  it('puts the name in bold above the text on WhatsApp channels', () => {
    expect(withAgentName('Olá!', 'Ana Souza', 'whatsapp')).toBe('*Ana Souza:*\nOlá!')
    expect(withAgentName('Olá!', 'Ana', 'qr')).toBe('*Ana:*\nOlá!')
    expect(withAgentName('Olá!', 'Ana', null)).toBe('*Ana:*\nOlá!')
  })

  it('uses plain text on Instagram and Messenger', () => {
    expect(withAgentName('Oi', 'Ana', 'instagram')).toBe('Ana:\nOi')
    expect(withAgentName('Oi', 'Ana', 'messenger')).toBe('Ana:\nOi')
  })

  it('leaves the text alone without a usable name or text', () => {
    expect(withAgentName('Oi', '', 'whatsapp')).toBe('Oi')
    expect(withAgentName('Oi', '  ** ', 'whatsapp')).toBe('Oi')
    expect(withAgentName('Oi', null, 'whatsapp')).toBe('Oi')
    expect(withAgentName('', 'Ana', 'whatsapp')).toBe('')
  })

  it('strips formatting marks and line breaks from the name and caps its length', () => {
    expect(cleanAgentName(' *Ana*\n_Maria_ ')).toBe('Ana Maria')
    expect(cleanAgentName('a'.repeat(60))).toHaveLength(40)
  })
})

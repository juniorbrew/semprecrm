import { describe, expect, it } from 'vitest'

import { findDuplicateAutomations } from './duplicates'

const row = (id: string, over: Record<string, unknown> = {}) =>
  ({
    id,
    name: `Rule ${id}`,
    trigger_type: 'new_message_received',
    trigger_config: {},
    is_active: true,
    ...over,
  }) as never

describe('findDuplicateAutomations', () => {
  it('flags two active rules on the same trigger, both ways', () => {
    const dup = findDuplicateAutomations([row('a'), row('b')])
    expect(dup.get('a')).toEqual(['Rule b'])
    expect(dup.get('b')).toEqual(['Rule a'])
  })

  it('ignores inactive rules', () => {
    expect(findDuplicateAutomations([row('a'), row('b', { is_active: false })]).size).toBe(0)
  })

  it('treats keyword lists as equal regardless of order and case', () => {
    const dup = findDuplicateAutomations([
      row('a', { trigger_type: 'keyword_match', trigger_config: { keywords: ['Preço', 'valor'], match_type: 'contains' } }),
      row('b', { trigger_type: 'keyword_match', trigger_config: { match_type: 'contains', keywords: ['valor', 'preço'] } }),
    ])
    expect(dup.size).toBe(2)
  })

  it('does not flag different trigger settings', () => {
    const dup = findDuplicateAutomations([
      row('a', { trigger_type: 'tag_added', trigger_config: { tag_id: 't1' } }),
      row('b', { trigger_type: 'tag_added', trigger_config: { tag_id: 't2' } }),
    ])
    expect(dup.size).toBe(0)
  })
})

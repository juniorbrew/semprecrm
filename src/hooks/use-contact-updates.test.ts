import { describe, expect, it } from 'vitest'

import type { Contact, Conversation } from '@/types'
import { applyContactUpdate } from './use-contact-updates'

const contact = (extra: Partial<Contact> = {}): Contact => ({
  id: 'c-1',
  user_id: 'u-1',
  account_id: 'a-1',
  phone: '5511988887777',
  name: 'Maria',
  created_at: '2026-09-27T00:00:00Z',
  updated_at: '2026-09-27T00:00:00Z',
  ...extra,
})

const conversation = (id: string, contactId: string, c?: Contact): Conversation => ({
  id,
  user_id: 'u-1',
  contact_id: contactId,
  status: 'open',
  unread_count: 0,
  created_at: '2026-09-27T00:00:00Z',
  updated_at: '2026-09-27T00:00:00Z',
  contact: c,
})

describe('applyContactUpdate (live contact photo)', () => {
  it('puts the new avatar on every conversation of that contact', () => {
    const list = [
      conversation('conv-1', 'c-1', contact()),
      conversation('conv-2', 'c-2', contact({ id: 'c-2', name: 'João' })),
      conversation('conv-0', 'c-1', contact()),
    ]
    const next = applyContactUpdate(list, contact({ avatar_url: 'https://x/a.jpg' }))
    expect(next[0].contact?.avatar_url).toBe('https://x/a.jpg')
    expect(next[2].contact?.avatar_url).toBe('https://x/a.jpg')
    expect(next[1]).toBe(list[1])
  })

  it('returns the same array when the contact is not in the list', () => {
    const list = [conversation('conv-2', 'c-2', contact({ id: 'c-2' }))]
    expect(applyContactUpdate(list, contact({ avatar_url: 'https://x/a.jpg' }))).toBe(list)
  })
})

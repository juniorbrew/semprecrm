import { describe, expect, it } from 'vitest'

import { conversationHeaderActions } from './header-actions'

const open = { status: 'open' as const, assigned_agent_id: undefined }

describe('conversationHeaderActions — permissions', () => {
  it('agents, admins and owners can act', () => {
    for (const role of ['agent', 'admin', 'owner'] as const) {
      const a = conversationHeaderActions({ role, userId: 'u1', conversation: open, tasksEnabled: true })
      expect(a.canWrite).toBe(true)
      expect(a.claim).toEqual({ visible: true, enabled: true })
      expect(a.transfer.enabled).toBe(true)
      expect(a.remind.enabled).toBe(true)
      expect(a.close.enabled).toBe(true)
      expect(a.archive.enabled).toBe(true)
    }
  })

  it('viewers see every control, all disabled', () => {
    const a = conversationHeaderActions({ role: 'viewer', userId: 'u1', conversation: open, tasksEnabled: true })
    expect(a.canWrite).toBe(false)
    for (const key of ['claim', 'transfer', 'remind', 'close', 'archive'] as const) {
      expect(a[key]).toEqual({ visible: true, enabled: false })
    }
  })

  it('an unknown role (profile still loading) enables nothing', () => {
    const a = conversationHeaderActions({ role: null, userId: 'u1', conversation: open, tasksEnabled: true })
    expect(a.canWrite).toBe(false)
    expect(a.claim.enabled).toBe(false)
  })
})

describe('conversationHeaderActions — visibility', () => {
  it('hides Assumir on my own or a closed conversation, shows it on a teammate’s', () => {
    const base = { role: 'agent' as const, userId: 'u1', tasksEnabled: true }
    expect(conversationHeaderActions({ ...base, conversation: { status: 'open', assigned_agent_id: 'u1' } }).claim.visible).toBe(false)
    expect(conversationHeaderActions({ ...base, conversation: { status: 'closed', assigned_agent_id: undefined } }).claim.visible).toBe(false)
    expect(conversationHeaderActions({ ...base, conversation: { status: 'pending', assigned_agent_id: 'u2' } }).claim.visible).toBe(true)
  })

  it('offers Arquivar or Desarquivar depending on archived_at', () => {
    const base = { role: 'agent' as const, userId: 'u1', tasksEnabled: true }
    const live = conversationHeaderActions({ ...base, conversation: open })
    expect([live.archive.visible, live.unarchive.visible]).toEqual([true, false])
    const archived = conversationHeaderActions({
      ...base,
      conversation: { status: 'closed', assigned_agent_id: undefined, archived_at: '2026-09-27T10:00:00Z' },
    })
    expect([archived.archive.visible, archived.unarchive.visible]).toEqual([false, true])
    expect(archived.unarchive.enabled).toBe(true)
  })

  it('hides Lembrar without the Tasks module', () => {
    const a = conversationHeaderActions({ role: 'agent', userId: 'u1', conversation: open, tasksEnabled: false })
    expect(a.remind).toEqual({ visible: false, enabled: false })
  })
})

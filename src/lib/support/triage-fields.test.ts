import { describe, expect, it, vi } from 'vitest'

import { normalizeCategoryDraft } from './categories'
import { activeCategories, DEFAULT_RESOLUTION, RESOLVE_AS_OPTIONS, RESOLUTIONS, resolutionNote, type ConversationCategory } from './model'
import { aiPriority, manualTriagePatch, resolvePatch, sanitizeSubject, triageEvents } from './triage-fields'

describe('manual edits', () => {
  it('a manual edit marks the triage as human, so the AI never overwrites it', () => {
    const patch = manualTriagePatch({ priority: 'urgent' }, { now: new Date('2026-09-30T10:00:00Z') })
    expect(patch).toEqual({ priority: 'urgent', priority_manual: true, triage_source: 'manual', triage_at: '2026-09-30T10:00:00.000Z' })
  })

  it('resolving defaults to "resolved" (one click) and accepts another outcome', () => {
    expect(DEFAULT_RESOLUTION).toBe('resolved')
    expect(resolvePatch()).toEqual({ status: 'closed', resolution: 'resolved' })
    expect(resolvePatch('duplicate')).toEqual({ status: 'closed', resolution: 'duplicate' })
  })
})

describe('manualTriagePatch rules', () => {
  const now = new Date('2026-09-30T10:00:00Z')
  it('a subject-only edit does not mark the triage manual', () => {
    expect(manualTriagePatch({ subject: 'x' }, { now })).toEqual({ subject: 'x' })
  })
  it('a category change applies its default priority unless the agent pinned the priority', () => {
    const category = { default_priority: 'high' as const }
    expect(manualTriagePatch({ category_id: 'c1' }, { now, category })).toMatchObject({ category_id: 'c1', priority: 'high', triage_source: 'manual' })
    expect(manualTriagePatch({ category_id: 'c1' }, { now, category, current: { priority_manual: true } })).not.toHaveProperty('priority')
  })
  it('AI priority: default only lifts a normal answer and never moves a pinned priority', () => {
    const c = { default_priority: 'high' as const }
    expect(aiPriority('normal', c, false, 'normal')).toBe('high')
    expect(aiPriority('urgent', c, false, 'normal')).toBe('urgent')
    expect(aiPriority('low', c, false, 'normal')).toBe('low')
    expect(aiPriority('urgent', c, true, 'low')).toBe('low')
  })
})

describe('resolution options', () => {
  it('"Resolver como…" lists every outcome except the one-click default', () => {
    expect(RESOLVE_AS_OPTIONS).toEqual(['not_applicable', 'closed_by_customer', 'expired', 'duplicate'])
    expect([DEFAULT_RESOLUTION, ...RESOLVE_AS_OPTIONS].sort()).toEqual([...RESOLUTIONS].sort())
  })
  it('the outcome is only noted on closed conversations and only when it adds information', () => {
    expect(resolutionNote('closed', 'duplicate')).toBe('duplicate')
    expect(resolutionNote('closed', 'resolved')).toBeNull()
    expect(resolutionNote('closed', null)).toBeNull()
    expect(resolutionNote('open', 'duplicate')).toBeNull()
  })
})

describe('triageEvents', () => {
  const cats = new Map([['c1', { name: 'Cobrança' }]])
  it('one event per field that changed; none when nothing did', () => {
    expect(triageEvents({ category_id: null, priority: 'normal' }, { category_id: 'c1', priority: 'normal' }, cats)).toEqual([
      { event_type: 'category_changed', payload: { category_id: 'c1', category_name: 'Cobrança' } },
    ])
    expect(triageEvents({ category_id: 'c1', priority: 'normal' }, { category_id: null }, cats)[0].payload).toEqual({
      category_id: null,
      category_name: null,
    })
    expect(triageEvents({ priority: 'normal' }, { priority: 'high' }, cats)[0].payload).toEqual({
      priority: 'high',
      previous_priority: 'normal',
    })
    expect(triageEvents({ category_id: 'c1', priority: 'high' }, { category_id: 'c1', priority: 'high' }, cats)).toEqual([])
  })
  it('subject changes leave no event (it may hold personal data)', () => {
    expect(triageEvents({ subject: null }, { subject: 'Boleto da Maria' }, cats)).toEqual([])
  })
  it('marks AI events', () => {
    expect(triageEvents({ priority: 'normal' }, { priority: 'urgent' }, cats, 'ai')[0].payload.source).toBe('ai')
  })
})

describe('sanitizeSubject', () => {
  it('trims, collapses whitespace, drops control chars and tags', () => {
    expect(sanitizeSubject('  Erro \n ao\tentrar ')).toBe('Erro ao entrar')
    expect(sanitizeSubject('<script>x</script>Sem acesso')).toBe('xSem acesso')
    expect(sanitizeSubject('')).toBeNull()
    expect(sanitizeSubject(null)).toBeNull()
  })
  it('caps at 120 characters (counting code points)', () => {
    const out = sanitizeSubject('é'.repeat(200))!
    expect(Array.from(out)).toHaveLength(120)
  })
})

describe('normalizeCategoryDraft', () => {
  it('trims the name and rejects blank / > 40 chars', () => {
    expect(normalizeCategoryDraft({ name: '  Cobrança   geral ' })).toEqual({ ok: true, fields: { name: 'Cobrança geral' } })
    expect(normalizeCategoryDraft({ name: '  ' })).toEqual({ ok: false, error: 'name' })
    expect(normalizeCategoryDraft({ name: 'x'.repeat(41) })).toEqual({ ok: false, error: 'name' })
  })
  it('limits description (200), palette and priority', () => {
    expect(normalizeCategoryDraft({ description: 'x'.repeat(201) })).toEqual({ ok: false, error: 'description' })
    expect(normalizeCategoryDraft({ description: '  ' })).toEqual({ ok: true, fields: { description: null } })
    expect(normalizeCategoryDraft({ color: 'chartreuse' as never })).toEqual({ ok: false, error: 'color' })
    expect(normalizeCategoryDraft({ default_priority: 'critical' as never })).toEqual({ ok: false, error: 'priority' })
  })
})

describe('activeCategories', () => {
  it('hides archived and orders by position then name', () => {
    const c = (id: string, name: string, position: number, archived_at: string | null = null) =>
      ({ id, name, position, archived_at }) as ConversationCategory
    expect(activeCategories([c('3', 'B', 1), c('1', 'Z', 0), c('2', 'A', 1), c('4', 'Old', 0, 'x')]).map((x) => x.id)).toEqual(['1', '2', '3'])
  })
})

describe('scheduleTriageIfDue', () => {
  it('does nothing unless the ingest flagged the 1st / 3rd message', async () => {
    const after = vi.fn()
    const runQuiet = vi.fn().mockResolvedValue(null)
    vi.resetModules()
    vi.doMock('next/server', () => ({ after }))
    vi.doMock('@/lib/automations/admin-client', () => ({ supabaseAdmin: () => ({ admin: true }) }))
    vi.doMock('./ai-triage', () => ({ runTriageQuietly: runQuiet }))
    const { scheduleTriageIfDue } = await import('./triage-trigger')

    scheduleTriageIfDue({ conversationId: 'c1' }, 'acc')
    scheduleTriageIfDue({ triageDue: true }, 'acc')
    expect(after).not.toHaveBeenCalled()

    scheduleTriageIfDue({ triageDue: true, conversationId: 'c1' }, 'acc')
    expect(after).toHaveBeenCalledTimes(1)
    await after.mock.calls[0][0]()
    expect(runQuiet).toHaveBeenCalledWith({ admin: true }, { accountId: 'acc', conversationId: 'c1' })
  })

  it('falls back to fire-and-forget outside a request scope', async () => {
    const runQuiet = vi.fn().mockResolvedValue(null)
    vi.resetModules()
    vi.doMock('next/server', () => ({
      after: () => {
        throw new Error('outside request scope')
      },
    }))
    vi.doMock('@/lib/automations/admin-client', () => ({ supabaseAdmin: () => ({}) }))
    vi.doMock('./ai-triage', () => ({ runTriageQuietly: runQuiet }))
    const { scheduleTriageIfDue } = await import('./triage-trigger')
    scheduleTriageIfDue({ triageDue: true, conversationId: 'c1' }, 'acc')
    expect(runQuiet).toHaveBeenCalledTimes(1)
  })
})

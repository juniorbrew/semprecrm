import { describe, expect, it, vi } from 'vitest'

import {
  AUDIT_ACTIONS,
  AUDIT_ACTION_LABELS,
  AUDIT_ACTION_LIST,
  AUDIT_METADATA_MAX_BYTES,
  CLIENT_AUDIT_ACTIONS,
  auditActionLabel,
  isAuditAction,
  logAudit,
  sanitizeAuditMetadata,
} from './audit'

type Row = Record<string, unknown>

function makeAdmin(opts: { insertError?: { message: string } | null; profile?: Row | null; throwOnInsert?: boolean } = {}) {
  const inserted: Row[] = []
  const admin = {
    from(table: string) {
      if (table === 'profiles') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: opts.profile ?? null, error: null }),
            }),
          }),
        }
      }
      if (table === 'audit_log') {
        return {
          insert: async (row: Row) => {
            if (opts.throwOnInsert) throw new Error('boom')
            inserted.push(row)
            return { error: opts.insertError ?? null }
          },
        }
      }
      throw new Error(`unexpected table ${table}`)
    },
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { admin: admin as any, inserted }
}

describe('audit catalogue', () => {
  it('has a label in both languages for every action', () => {
    for (const action of AUDIT_ACTION_LIST) {
      expect(AUDIT_ACTION_LABELS['pt-BR'][action]).toBeTruthy()
      expect(AUDIT_ACTION_LABELS['en-US'][action]).toBeTruthy()
    }
    expect(Object.keys(AUDIT_ACTION_LABELS['pt-BR'])).toHaveLength(AUDIT_ACTION_LIST.length)
  })

  it('contains the 22 spec actions plus account.registration_updated (042)', () => {
    expect(AUDIT_ACTION_LIST).toHaveLength(23)
    expect(AUDIT_ACTION_LIST).toContain('account.registration_updated')
    expect(AUDIT_ACTION_LIST).toContain('member.role_changed')
    expect(AUDIT_ACTION_LIST).toContain('plan.changed')
    expect(AUDIT_ACTION_LIST).toContain('mfa.disabled')
  })

  it('isAuditAction accepts catalogue keys only', () => {
    expect(isAuditAction('contact.deleted')).toBe(true)
    expect(isAuditAction('contact.made_up')).toBe(false)
    expect(isAuditAction(42)).toBe(false)
    expect(isAuditAction(null)).toBe(false)
  })

  it('auditActionLabel falls back to the raw key for unknown actions', () => {
    expect(auditActionLabel('member.removed', 'pt-BR')).toBe('Membro removido')
    expect(auditActionLabel('member.removed', 'en-US')).toBe('Member removed')
    expect(auditActionLabel('weird.action', 'pt-BR')).toBe('weird.action')
  })

  it('client-recordable actions are a strict subset that excludes server-owned ones', () => {
    for (const a of CLIENT_AUDIT_ACTIONS) expect(isAuditAction(a)).toBe(true)
    expect(CLIENT_AUDIT_ACTIONS.has(AUDIT_ACTIONS.PLAN_CHANGED)).toBe(false)
    expect(CLIENT_AUDIT_ACTIONS.has(AUDIT_ACTIONS.MEMBER_ROLE_CHANGED)).toBe(false)
    expect(CLIENT_AUDIT_ACTIONS.has(AUDIT_ACTIONS.CONTACT_DELETED)).toBe(true)
  })
})

describe('sanitizeAuditMetadata', () => {
  it('returns {} for non-objects', () => {
    expect(sanitizeAuditMetadata(null)).toEqual({})
    expect(sanitizeAuditMetadata('x')).toEqual({})
    expect(sanitizeAuditMetadata([1, 2])).toEqual({})
  })

  it('deep-copies plain objects and drops undefined/functions', () => {
    const out = sanitizeAuditMetadata({ a: 1, b: undefined, c: () => 1, d: { e: 'x' } })
    expect(out).toEqual({ a: 1, d: { e: 'x' } })
  })

  it('replaces oversize payloads with a marker', () => {
    const big = { blob: 'x'.repeat(AUDIT_METADATA_MAX_BYTES + 10) }
    const out = sanitizeAuditMetadata(big)
    expect(out.truncated).toBe(true)
    expect(typeof out.bytes).toBe('number')
  })
})

describe('logAudit', () => {
  it('writes the row and resolves the actor name from profiles', async () => {
    const { admin, inserted } = makeAdmin({ profile: { full_name: 'Ana', email: 'ana@x.com' } })
    const ok = await logAudit(admin, {
      accountId: 'acc-1',
      actorUserId: 'user-1',
      action: AUDIT_ACTIONS.MEMBER_ROLE_CHANGED,
      entityType: 'member',
      entityId: 'user-2',
      metadata: { from: 'agent', to: 'admin' },
    })
    expect(ok).toBe(true)
    expect(inserted).toHaveLength(1)
    expect(inserted[0]).toMatchObject({
      account_id: 'acc-1',
      actor_user_id: 'user-1',
      actor_name: 'Ana',
      action: 'member.role_changed',
      entity_type: 'member',
      entity_id: 'user-2',
      metadata: { from: 'agent', to: 'admin' },
    })
  })

  it('uses the explicit actor name and null actor for platform actions', async () => {
    const { admin, inserted } = makeAdmin()
    await logAudit(admin, {
      accountId: 'acc-1',
      actorUserId: null,
      actorName: 'Platform admin',
      action: AUDIT_ACTIONS.PLAN_CHANGED,
      entityType: 'plan',
    })
    expect(inserted[0]).toMatchObject({
      actor_user_id: null,
      actor_name: 'Platform admin',
      entity_id: null,
      metadata: {},
    })
  })

  it('never throws — insert error', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { admin } = makeAdmin({ insertError: { message: 'relation missing' } })
    const ok = await logAudit(admin, {
      accountId: 'acc-1',
      actorUserId: null,
      action: AUDIT_ACTIONS.ACCOUNT_RENAMED,
      entityType: 'account',
    })
    expect(ok).toBe(false)
    expect(spy).toHaveBeenCalled()
  })

  it('never throws — client throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { admin } = makeAdmin({ throwOnInsert: true })
    await expect(
      logAudit(admin, {
        accountId: 'acc-1',
        actorUserId: null,
        action: AUDIT_ACTIONS.ACCOUNT_RENAMED,
        entityType: 'account',
      }),
    ).resolves.toBe(false)
  })

  it('refuses actions outside the catalogue', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { admin, inserted } = makeAdmin()
    const ok = await logAudit(admin, {
      accountId: 'acc-1',
      actorUserId: null,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      action: 'nope.nope' as any,
      entityType: 'account',
    })
    expect(ok).toBe(false)
    expect(inserted).toHaveLength(0)
  })
})

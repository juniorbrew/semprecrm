import { describe, expect, it, vi } from 'vitest'

import {
  READ_ONLY_EDIT_MESSAGES,
  isRlsDenied,
  readOnlyDbMessage,
  withReadOnlyDbMessage,
} from './read-only-db-error'

const rls = { code: '42501', message: 'new row violates row-level security policy for table "contacts"' }
const guard = { code: '42501', message: 'read_only_account: this account is read-only (trial ended or payment overdue)' }

describe('isRlsDenied', () => {
  it('recognises the policy refusal and the guard trigger', () => {
    expect(isRlsDenied(rls)).toBe(true)
    expect(isRlsDenied(guard)).toBe(true)
  })
  it('ignores other errors', () => {
    expect(isRlsDenied({ code: '23505', message: 'duplicate key' })).toBe(false)
    expect(isRlsDenied({ code: '42501', message: 'permission denied for table x' })).toBe(false)
    expect(isRlsDenied(null)).toBe(false)
    expect(isRlsDenied(undefined)).toBe(false)
  })
})

describe('readOnlyDbMessage', () => {
  it('maps to the pt-BR copy of the account reason', () => {
    expect(readOnlyDbMessage(rls, 'trial_expired')).toBe(READ_ONLY_EDIT_MESSAGES.trial_expired)
    expect(readOnlyDbMessage(guard, 'past_due')).toBe(READ_ONLY_EDIT_MESSAGES.past_due)
    expect(READ_ONLY_EDIT_MESSAGES.trial_expired).toContain('somente leitura')
  })
  it('keeps the original error for an active account (a viewer hitting RLS is not billing)', () => {
    expect(readOnlyDbMessage(rls, null)).toBeNull()
  })
  it('keeps unrelated errors', () => {
    expect(readOnlyDbMessage({ code: '23505', message: 'x' }, 'past_due')).toBeNull()
  })
})

describe('withReadOnlyDbMessage', () => {
  const denied = () =>
    new Response(JSON.stringify(rls), { status: 403, headers: { 'content-type': 'application/json' } })

  it('rewrites a refused write and notifies once', async () => {
    const notify = vi.fn()
    const f = withReadOnlyDbMessage(async () => denied(), () => 'trial_expired', notify)
    const res = await f('https://x/rest/v1/contacts', { method: 'POST' })
    const body = await res.json()
    expect(res.status).toBe(403)
    expect(body.code).toBe('42501')
    expect(body.message).toBe(READ_ONLY_EDIT_MESSAGES.trial_expired)
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify).toHaveBeenCalledWith(READ_ONLY_EDIT_MESSAGES.trial_expired)
  })

  it('leaves the response alone when the account is writable, on reads, or on other errors', async () => {
    const notify = vi.fn()
    const writable = withReadOnlyDbMessage(async () => denied(), () => null, notify)
    expect((await (await writable('https://x', { method: 'POST' })).json()).message).toBe(rls.message)

    const get = withReadOnlyDbMessage(async () => denied(), () => 'past_due', notify)
    expect((await (await get('https://x', { method: 'GET' })).json()).message).toBe(rls.message)

    const other = withReadOnlyDbMessage(
      async () => new Response('not json', { status: 403 }),
      () => 'past_due',
      notify,
    )
    expect(await (await other('https://x', { method: 'POST' })).text()).toBe('not json')
    expect(notify).not.toHaveBeenCalled()
  })

  it('passes successful writes through untouched', async () => {
    const ok = new Response('[]', { status: 201 })
    const f = withReadOnlyDbMessage(async () => ok, () => 'past_due', vi.fn())
    expect(await f('https://x', { method: 'POST' })).toBe(ok)
  })
})

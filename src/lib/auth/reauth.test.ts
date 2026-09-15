import { beforeEach, describe, expect, it, vi } from 'vitest'

const { signInWithPassword, signOut, createClient } = vi.hoisted(() => {
  const signInWithPassword = vi.fn()
  const signOut = vi.fn()
  const createClient = vi.fn(() => ({ auth: { signInWithPassword, signOut } }))
  return { signInWithPassword, signOut, createClient }
})

vi.mock('@supabase/supabase-js', () => ({ createClient }))

import { REAUTH_STORAGE_KEY, verifyPassword } from './reauth'

beforeEach(() => {
  vi.clearAllMocks()
  signOut.mockResolvedValue({ error: null })
})

describe('verifyPassword', () => {
  it('signs in on a throwaway, non-persisting client', async () => {
    signInWithPassword.mockResolvedValue({ error: null })

    await verifyPassword('a@b.c', 'secret')

    expect(createClient).toHaveBeenCalledTimes(1)
    const [, , options] = createClient.mock.calls[0] as unknown as [string, string, { auth: Record<string, unknown> }]
    expect(options.auth).toMatchObject({
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
      storageKey: REAUTH_STORAGE_KEY,
    })
    expect(signInWithPassword).toHaveBeenCalledWith({ email: 'a@b.c', password: 'secret' })
  })

  it('returns true and revokes only the probe session on success', async () => {
    signInWithPassword.mockResolvedValue({ error: null })

    await expect(verifyPassword('a@b.c', 'secret')).resolves.toBe(true)
    expect(signOut).toHaveBeenCalledWith({ scope: 'local' })
  })

  it('returns false and does not sign out when the password is wrong', async () => {
    signInWithPassword.mockResolvedValue({ error: { message: 'Invalid login credentials' } })

    await expect(verifyPassword('a@b.c', 'nope')).resolves.toBe(false)
    expect(signOut).not.toHaveBeenCalled()
  })

  it('still returns true when revoking the probe session fails', async () => {
    signInWithPassword.mockResolvedValue({ error: null })
    signOut.mockRejectedValue(new Error('network'))

    await expect(verifyPassword('a@b.c', 'secret')).resolves.toBe(true)
  })
})

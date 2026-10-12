// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

const h = vi.hoisted(() => ({
  auth: {
    accountId: 'acc-1' as string | null,
    canManageMembers: true,
    account: { plan_status: 'trial', plan_expires_at: new Date(Date.now() + 13.5 * 86_400_000).toISOString() } as Record<string, unknown>,
  },
  status: { whatsapp: false, contacts: true, team: false, ai: false },
  load: vi.fn(),
}))

vi.mock('@/hooks/use-auth', () => ({ useAuth: () => h.auth }))
vi.mock('@/lib/supabase/client', () => ({ createClient: () => ({}) }))
vi.mock('@/lib/dashboard/onboarding', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/dashboard/onboarding')>()
  return { ...actual, loadOnboardingStatus: h.load }
})

import { GettingStarted } from './getting-started'

beforeEach(() => {
  h.auth.canManageMembers = true
  h.status = { whatsapp: false, contacts: true, team: false, ai: false }
  h.load.mockReset()
  h.load.mockImplementation(async () => h.status)
  window.localStorage.clear()
})
afterEach(cleanup)

describe('GettingStarted', () => {
  it('lists the steps, ticks what is done and shows the trial days', async () => {
    render(<GettingStarted />)
    await waitFor(() => expect(screen.getByText('Primeiros passos')).toBeTruthy())
    expect(screen.getByText(/1 de 3 passos concluídos/)).toBeTruthy()
    expect(screen.getByText(/14 dias restantes no teste grátis/)).toBeTruthy()
    expect(screen.getByText('Conectar o WhatsApp')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Conectar' }).getAttribute('href')).toBe('/settings?tab=whatsapp')
    // contacts is done: no action link for it
    expect(screen.queryByRole('link', { name: 'Abrir contatos' })).toBeNull()
    expect(h.load).toHaveBeenCalledWith(expect.anything(), 'acc-1')
  })

  it('stays hidden for agents (no query) and once the required steps are done', async () => {
    h.auth.canManageMembers = false
    const { container, unmount } = render(<GettingStarted />)
    expect(container.innerHTML).toBe('')
    expect(h.load).not.toHaveBeenCalled()
    unmount()

    h.auth.canManageMembers = true
    h.status = { whatsapp: true, contacts: true, team: true, ai: false } // AI is optional
    const second = render(<GettingStarted />)
    await waitFor(() => expect(h.load).toHaveBeenCalled())
    expect(second.container.innerHTML).toBe('')
  })

  it('hiding it sticks for this account in this browser', async () => {
    const first = render(<GettingStarted />)
    await waitFor(() => expect(screen.getByText('Primeiros passos')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Ocultar primeiros passos' }))
    expect(first.container.innerHTML).toBe('')
    first.unmount()

    const again = render(<GettingStarted />)
    await waitFor(() => expect(h.load).toHaveBeenCalledTimes(2))
    expect(again.container.innerHTML).toBe('')
  })
})

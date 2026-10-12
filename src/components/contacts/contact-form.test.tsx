// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

const h = vi.hoisted(() => ({ inserts: [] as Record<string, unknown>[] }))

function builder(table: string) {
  const b: Record<string, unknown> = {
    select: () => b,
    order: () => b,
    eq: () => b,
    delete: () => b,
    insert: (row: Record<string, unknown>) => {
      if (table === 'contacts') h.inserts.push(row)
      return b
    },
    single: async () => ({ data: { id: 'c-new' }, error: null }),
    then: (resolve: (v: unknown) => unknown) => resolve({ data: [], error: null }),
  }
  return b
}

vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    auth: { getSession: async () => ({ data: { session: { user: { id: 'u-1' } } } }) },
    from: (table: string) => builder(table),
  }),
}))
vi.mock('@/hooks/use-auth', () => ({ useAuth: () => ({ accountId: 'acc-1' }) }))
vi.mock('@/lib/contacts/apply-suppressions', () => ({ applySuppressions: async () => undefined }))
vi.mock('@/lib/contacts/dedupe', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/contacts/dedupe')>()
  // The on-blur duplicate lookup is still running when the click lands.
  return { ...actual, findExistingContact: () => new Promise(() => {}) }
})

import { ContactForm } from './contact-form'

beforeEach(() => {
  h.inserts = []
})
afterEach(cleanup)

describe('ContactForm', () => {
  it('saves on the first click when the phone was the last field typed', async () => {
    const onSaved = vi.fn()
    render(<ContactForm open onOpenChange={() => {}} onSaved={onSaved} />)
    const phone = await waitFor(() => {
      const el = document.querySelector<HTMLInputElement>('#cf-phone')
      if (!el) throw new Error('phone field not rendered yet')
      return el
    })
    fireEvent.change(phone, { target: { value: '(21) 99876-5432' } })
    // Clicking "Criar" blurs the phone field first, which starts the lookup.
    fireEvent.blur(phone)
    fireEvent.click(screen.getByRole('button', { name: 'Criar' }))

    await waitFor(() => expect(h.inserts).toHaveLength(1))
    expect(h.inserts[0]).toMatchObject({ account_id: 'acc-1', phone: '5521998765432' })
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
  })
})

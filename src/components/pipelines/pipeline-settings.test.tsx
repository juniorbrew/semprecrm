// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

const h = vi.hoisted(() => ({
  upsert: vi.fn(),
}))

vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    from: (table: string) => ({
      update: () => ({ eq: () => Promise.resolve({ error: null }) }),
      upsert: (rows: unknown) => (table === 'pipeline_stages' ? h.upsert(rows) : Promise.resolve({ error: null })),
    }),
  }),
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

import { PipelineSettings } from './pipeline-settings'

const pipeline = { id: 'pl', name: 'Vendas' } as never
const stage = (id: string, position: number, win_probability: number | null = null) =>
  ({ id, pipeline_id: 'pl', name: `Etapa ${id}`, position, color: '#3b82f6', win_probability }) as never
const stages = [stage('a', 0), stage('b', 1, 40), stage('c', 2), stage('d', 3)]

function setup() {
  return render(
    <PipelineSettings
      open
      onOpenChange={() => {}}
      pipeline={pipeline}
      stages={stages}
      onPipelinesChanged={() => {}}
      onStagesChanged={() => {}}
      onCreateNewPipeline={() => {}}
    />,
  )
}
const fields = () => screen.getAllByLabelText('% de chance de fechar') as HTMLInputElement[]

beforeEach(() => {
  h.upsert.mockReset()
  h.upsert.mockResolvedValue({ error: null })
})
afterEach(cleanup)

describe('PipelineSettings: chance to close per stage', () => {
  it('shows the set value, and the automatic value as the hint of the empty ones', () => {
    setup()
    const [a, b, c, d] = fields()
    expect(b.value).toBe('40')
    expect(a.value).toBe('')
    expect(a.placeholder).toBe('10') // first of four
    expect(c.placeholder).toBe('90') // the one before the last
    expect(d.placeholder).toBe('100') // last stage
    expect(screen.getAllByText('Chance automática')).toHaveLength(3)
  })

  it('accepts a whole number 0-100 and does not rewrite what is typed', () => {
    setup()
    const [a] = fields()
    fireEvent.change(a, { target: { value: '35' } })
    expect(a.value).toBe('35')
    // typing "150" is left alone while typing (no jump), and Save waits
    fireEvent.change(a, { target: { value: '150' } })
    expect(a.value).toBe('150')
    expect(screen.getByRole('button', { name: /Salvar alterações|Save Changes/ }).hasAttribute('disabled')).toBe(true)
  })

  it('on blur an out-of-range or fractional number is clamped / rounded', () => {
    setup()
    const [a] = fields()
    fireEvent.change(a, { target: { value: '150' } })
    fireEvent.blur(a)
    expect(a.value).toBe('100')
    fireEvent.change(a, { target: { value: '-5' } })
    fireEvent.blur(a)
    expect(a.value).toBe('0')
    fireEvent.change(a, { target: { value: '12,6' } })
    fireEvent.blur(a)
    expect(a.value).toBe('13')
    expect(screen.getByRole('button', { name: /Salvar alterações|Save Changes/ }).hasAttribute('disabled')).toBe(false)
  })

  it('text that is not a number is flagged accessibly on blur, never silently turned into automatic', () => {
    setup()
    const [a, b] = fields()
    expect(b.value).toBe('40')
    fireEvent.change(b, { target: { value: '-' } })
    expect(b.value).toBe('-')
    expect(screen.queryByRole('alert')).toBeNull() // not while typing
    fireEvent.blur(b)
    const msg = screen.getByRole('alert')
    expect(msg.textContent).toMatch(/número inteiro de 0 a 100/)
    expect(b.getAttribute('aria-invalid')).toBe('true')
    expect(b.getAttribute('aria-describedby')).toBe(msg.id)
    expect(a.getAttribute('aria-invalid')).toBeNull()
    expect(screen.getByRole('button', { name: /Salvar alterações|Save Changes/ }).hasAttribute('disabled')).toBe(true)
    // fixing it clears the flag
    fireEvent.change(b, { target: { value: '55' } })
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByRole('button', { name: /Salvar alterações|Save Changes/ }).hasAttribute('disabled')).toBe(false)
  })

  it('"voltar ao automático" empties the field', () => {
    setup()
    expect(fields()[1].value).toBe('40')
    fireEvent.click(screen.getByRole('button', { name: /Voltar ao automático \(\d+%\)/ }))
    expect(fields()[1].value).toBe('')
  })

  it('saves the chances with the stages (empty = null)', async () => {
    setup()
    fireEvent.change(fields()[0], { target: { value: '25' } })
    fireEvent.click(screen.getByRole('button', { name: 'Voltar ao automático (50%)' }))
    fireEvent.click(screen.getByRole('button', { name: /Salvar alterações|Save Changes/ }))
    await waitFor(() => expect(h.upsert).toHaveBeenCalledTimes(1))
    const rows = h.upsert.mock.calls[0][0] as { id: string; win_probability: number | null }[]
    expect(rows.map((r) => [r.id, r.win_probability])).toEqual([['a', 25], ['b', null], ['c', null], ['d', null]])
  })
})

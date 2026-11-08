// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { toast } from 'sonner';

import type { DealField } from '@/lib/deal-fields/types';
import type { Deal, PipelineStage } from '@/types';

const h = vi.hoisted(() => ({ canEdit: true, readOnly: false, pipelines: true, ready: true }));

vi.mock('@/hooks/use-language', () => ({ useLanguage: () => ({ t: (s: string) => s, language: 'pt-BR' }) }));
vi.mock('@/hooks/use-auth', () => ({
  useAuth: () => ({ accountId: 'acc-1', defaultCurrency: 'BRL' }),
  useEntitlements: () => ({ ready: h.ready, modules: { pipelines: h.pipelines } }),
}));
vi.mock('@/hooks/use-can', () => ({ useCan: () => h.canEdit }));
vi.mock('@/hooks/use-read-only', () => ({ useReadOnly: () => ({ readOnly: h.readOnly }) }));
vi.mock('@/lib/supabase/client', () => ({ createClient: () => ({}) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/deal-fields/events', () => ({ notifyDealFieldsChanged: vi.fn(), onDealFieldsChanged: vi.fn() }));
vi.mock('@/lib/deal-fields/data', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/deal-fields/data')>()),
  listDealFields: vi.fn(),
  listDealFieldValues: vi.fn(),
  listItemSums: vi.fn(),
  setDealFieldValue: vi.fn(),
}));

import { listDealFields, listDealFieldValues, listItemSums, setDealFieldValue } from '@/lib/deal-fields/data';
import { notifyDealFieldsChanged } from '@/lib/deal-fields/events';
import { DealFieldsSection } from './deal-fields-section';

const CUSTO = '11111111-1111-4111-8111-111111111111';
const COM = '22222222-2222-4222-8222-222222222222';
const base = { account_id: 'acc-1', expression: null, result_format: null, show_on_card: false } as const;
const fields: DealField[] = [
  { ...base, id: CUSTO, name: 'Custo', kind: 'currency', position: 0 },
  { ...base, id: COM, name: '% comissão', kind: 'percent', position: 1 },
  {
    ...base,
    id: '33333333-3333-4333-8333-333333333333',
    name: 'Margem',
    kind: 'formula',
    expression: `{valor} - {f:${CUSTO}}`,
    result_format: 'currency',
    position: 2,
  },
  {
    ...base,
    id: '44444444-4444-4444-8444-444444444444',
    name: 'Comissão',
    kind: 'formula',
    expression: `{valor} * {f:${COM}}`,
    result_format: 'currency',
    position: 3,
  },
];
const stage = { id: 's1', pipeline_id: 'p', name: 'Proposta', position: 0, win_probability: 50 } as PipelineStage;
const deal = { id: 'd1', stage_id: 's1', value: 2000, currency: 'BRL', title: 'X' } as Deal;

beforeEach(() => {
  h.canEdit = true;
  h.readOnly = false;
  h.pipelines = true;
  h.ready = true;
  vi.mocked(listDealFields).mockResolvedValue(fields);
  vi.mocked(listDealFieldValues).mockResolvedValue({ [CUSTO]: 500 });
  vi.mocked(listItemSums).mockResolvedValue({});
  vi.mocked(setDealFieldValue).mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const rowOf = (name: string) => screen.getAllByText(name)[0].closest('li') as HTMLElement;

describe('DealFieldsSection', () => {
  it('shows every field in order: values formatted, formulas computed, "—" with the missing field named', async () => {
    render(<DealFieldsSection deal={deal} stages={[stage]} />);
    await screen.findByText('Custo');
    expect(rowOf('Custo').textContent).toMatch(/R\$\s500,00/);
    // 2000 - 500
    expect(rowOf('Margem').textContent).toMatch(/R\$\s1\.500,00/);
    // % comissão is empty: its formula is empty and says what to fill in
    expect(rowOf('Comissão').textContent).toContain('—');
    expect(rowOf('Comissão').textContent).toContain('Fill in % comissão');
    expect(rowOf('% comissão').textContent).toContain('—');
  });

  it('is hidden without the pipelines module, while entitlements load, and with no fields', async () => {
    h.pipelines = false;
    const a = render(<DealFieldsSection deal={deal} stages={[stage]} />);
    expect(a.container.innerHTML).toBe('');
    expect(listDealFields).not.toHaveBeenCalled();
    a.unmount();
    h.pipelines = true;
    h.ready = false;
    const b = render(<DealFieldsSection deal={deal} stages={[stage]} />);
    expect(b.container.innerHTML).toBe('');
    b.unmount();
    h.ready = true;
    vi.mocked(listDealFields).mockResolvedValue([]);
    const c = render(<DealFieldsSection deal={deal} stages={[stage]} />);
    await waitFor(() => expect(listDealFields).toHaveBeenCalled());
    await waitFor(() => expect(c.container.querySelector('section')).toBeNull());
  });

  it('edits a number in place: Enter saves, the formula recalculates', async () => {
    render(<DealFieldsSection deal={deal} stages={[stage]} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit: % comissão' }));
    const box = screen.getByLabelText('% comissão') as HTMLInputElement;
    fireEvent.change(box, { target: { value: '5' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(setDealFieldValue).toHaveBeenCalledWith(expect.anything(), 'acc-1', 'd1', COM, 5));
    // 2000 x 5% = 100
    await waitFor(() => expect(rowOf('Comissão').textContent).toMatch(/R\$\s100,00/));
    expect(rowOf('% comissão').textContent).toContain('5%');
    expect(notifyDealFieldsChanged).toHaveBeenCalled();
    expect(screen.queryByLabelText('% comissão')).toBeNull();
  });

  it('accepts pt-BR typing, clears with an empty box, Escape cancels, unchanged does not write', async () => {
    render(<DealFieldsSection deal={deal} stages={[stage]} />);
    fireEvent.click(await screen.findByRole('button', { name: /^Edit: Custo/ }));
    let box = screen.getByLabelText('Custo') as HTMLInputElement;
    expect(box.value).toBe('500');
    fireEvent.change(box, { target: { value: 'R$ 1.250,50' } });
    fireEvent.blur(box);
    await waitFor(() => expect(setDealFieldValue).toHaveBeenLastCalledWith(expect.anything(), 'acc-1', 'd1', CUSTO, 1250.5));

    fireEvent.click(await screen.findByRole('button', { name: /^Edit: Custo/ }));
    box = screen.getByLabelText('Custo') as HTMLInputElement;
    fireEvent.change(box, { target: { value: '' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(setDealFieldValue).toHaveBeenLastCalledWith(expect.anything(), 'acc-1', 'd1', CUSTO, null));
    await waitFor(() => expect(rowOf('Margem').textContent).toContain('Fill in Custo'));

    const writes = vi.mocked(setDealFieldValue).mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: /^Edit: Custo/ }));
    box = screen.getByLabelText('Custo') as HTMLInputElement;
    fireEvent.change(box, { target: { value: '99' } });
    fireEvent.keyDown(box, { key: 'Escape' });
    expect(screen.queryByLabelText('Custo')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^Edit: Custo/ }));
    fireEvent.blur(screen.getByLabelText('Custo'));
    expect(vi.mocked(setDealFieldValue).mock.calls.length).toBe(writes);
  });

  it('refuses text that is not a number and keeps the box open', async () => {
    render(<DealFieldsSection deal={deal} stages={[stage]} />);
    fireEvent.click(await screen.findByRole('button', { name: /^Edit: Custo/ }));
    const box = screen.getByLabelText('Custo') as HTMLInputElement;
    fireEvent.change(box, { target: { value: 'abc' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(within(rowOf('Custo')).getByRole('alert').textContent).toBe('Type a valid number, like 12,5');
    expect(box.getAttribute('aria-invalid')).toBe('true');
    expect(setDealFieldValue).not.toHaveBeenCalled();
  });

  it('a failed save shows the error and keeps the old value', async () => {
    vi.mocked(setDealFieldValue).mockRejectedValue({ code: '42501' });
    render(<DealFieldsSection deal={deal} stages={[stage]} />);
    fireEvent.click(await screen.findByRole('button', { name: /^Edit: Custo/ }));
    const box = screen.getByLabelText('Custo') as HTMLInputElement;
    fireEvent.change(box, { target: { value: '7' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('You do not have permission to change this, or the account is read-only'));
    // the box stays open for another try; cancelling shows the value as it was
    expect(screen.getByLabelText('Custo')).toBeTruthy();
    fireEvent.keyDown(screen.getByLabelText('Custo'), { key: 'Escape' });
    expect(rowOf('Custo').textContent).toMatch(/R\$\s500,00/);
  });

  it('a viewer, or a read-only account, only reads: no edit buttons, formulas never have one', async () => {
    h.canEdit = false;
    const a = render(<DealFieldsSection deal={deal} stages={[stage]} />);
    await screen.findByText('Custo');
    expect(screen.queryByRole('button', { name: /^Edit:/ })).toBeNull();
    a.unmount();
    h.canEdit = true;
    h.readOnly = true;
    render(<DealFieldsSection deal={deal} stages={[stage]} />);
    await screen.findByText('Custo');
    expect(screen.queryByRole('button', { name: /^Edit:/ })).toBeNull();
  });

  it('formulas have no edit button even for an admin', async () => {
    render(<DealFieldsSection deal={deal} stages={[stage]} />);
    await screen.findByText('Margem');
    expect(screen.queryByRole('button', { name: 'Edit: Margem' })).toBeNull();
    expect(screen.getAllByRole('button', { name: /^Edit:/ })).toHaveLength(2);
  });

  it('{Chance} uses the stage chance, {Itens} the item sum', async () => {
    vi.mocked(listItemSums).mockResolvedValue({ d1: 800 });
    vi.mocked(listDealFields).mockResolvedValue([
      {
        ...base,
        id: '55555555-5555-4555-8555-555555555555',
        name: 'Esperado',
        kind: 'formula',
        expression: '{itens} * {chance}',
        result_format: 'currency',
        position: 0,
      },
    ]);
    render(<DealFieldsSection deal={deal} stages={[stage]} />);
    // 800 x 0.5
    await waitFor(() => expect(rowOf('Esperado').textContent).toMatch(/R\$\s400,00/));
  });

  it('a formula whose field was deleted says so', async () => {
    vi.mocked(listDealFields).mockResolvedValue(fields.filter((f) => f.id !== CUSTO));
    render(<DealFieldsSection deal={deal} stages={[stage]} />);
    await screen.findByText('Margem');
    expect(rowOf('Margem').textContent).toContain('Deleted field');
  });

  it('offers a message when the fields cannot be read', async () => {
    vi.mocked(listDealFields).mockRejectedValue(new Error('offline'));
    render(<DealFieldsSection deal={deal} stages={[stage]} />);
    expect((await screen.findByRole('alert')).textContent).toBe('Could not load the fields.');
  });
});

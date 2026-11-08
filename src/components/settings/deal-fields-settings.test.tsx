// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { toast } from 'sonner';

import type { DealField } from '@/lib/deal-fields/types';

const h = vi.hoisted(() => ({ canEdit: true, readOnly: false }));

vi.mock('@/hooks/use-language', () => ({ useLanguage: () => ({ t: (s: string) => s, language: 'pt-BR' }) }));
vi.mock('@/hooks/use-auth', () => ({
  useAuth: () => ({ accountId: 'acc-1', user: { id: 'u1' }, defaultCurrency: 'BRL' }),
}));
vi.mock('@/hooks/use-can', () => ({ useCan: () => h.canEdit }));
vi.mock('@/hooks/use-read-only', () => ({ useReadOnly: () => ({ readOnly: h.readOnly }) }));
vi.mock('@/lib/supabase/client', () => ({ createClient: () => ({}) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/deal-fields/data', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/deal-fields/data')>()),
  listDealFields: vi.fn(),
  createDealField: vi.fn(),
  updateDealField: vi.fn(),
  deleteDealField: vi.fn(),
  reorderDealFields: vi.fn(),
}));

import {
  createDealField,
  deleteDealField,
  listDealFields,
  reorderDealFields,
  updateDealField,
} from '@/lib/deal-fields/data';
import { DealFieldsSettings } from './deal-fields-settings';

const CUSTO_ID = '11111111-1111-4111-8111-111111111111';
const field = (over: Partial<DealField> = {}): DealField => ({
  id: CUSTO_ID,
  account_id: 'acc-1',
  name: 'Custo',
  kind: 'currency',
  expression: null,
  result_format: null,
  show_on_card: false,
  position: 0,
  ...over,
});
const MARGEM = field({
  id: '22222222-2222-4222-8222-222222222222',
  name: 'Margem',
  kind: 'formula',
  expression: `{valor} - {f:${CUSTO_ID}}`,
  result_format: 'currency',
  position: 1,
});

beforeEach(() => {
  h.canEdit = true;
  h.readOnly = false;
  vi.mocked(listDealFields).mockResolvedValue([field(), MARGEM]);
  vi.mocked(createDealField).mockResolvedValue(undefined);
  vi.mocked(updateDealField).mockResolvedValue(undefined);
  vi.mocked(deleteDealField).mockResolvedValue(undefined);
  vi.mocked(reorderDealFields).mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('DealFieldsSettings', () => {
  it('lists the fields with kind and the formula with current names', async () => {
    render(<DealFieldsSettings />);
    expect(await screen.findByText('Custo')).toBeTruthy();
    expect(screen.getByText('Margem')).toBeTruthy();
    expect(screen.getByText('{Valor} − {Custo}')).toBeTruthy();
    expect(screen.getByText('Money field')).toBeTruthy();
    expect(screen.getByText('Formula field')).toBeTruthy();
  });

  it('creates a number field', async () => {
    render(<DealFieldsSettings />);
    fireEvent.click(await screen.findByRole('button', { name: 'New deal field' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Field name'), { target: { value: ' Frete ' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save field' }));
    await waitFor(() => expect(createDealField).toHaveBeenCalled());
    expect(createDealField).toHaveBeenCalledWith(
      expect.anything(),
      'acc-1',
      { name: 'Frete', kind: 'number', expression: null, result_format: null, show_on_card: false },
      2,
      'u1',
    );
    expect(toast.success).toHaveBeenCalledWith('Field created');
  });

  it('refuses a blank, a duplicate and a reserved name without saving', async () => {
    render(<DealFieldsSettings />);
    fireEvent.click(await screen.findByRole('button', { name: 'New deal field' }));
    const dialog = await screen.findByRole('dialog');
    const name = within(dialog).getByLabelText('Field name');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save field' }));
    expect(within(dialog).getByRole('alert').textContent).toBe('Type a name for the field');
    expect(name.getAttribute('aria-invalid')).toBe('true');
    fireEvent.change(name, { target: { value: 'custo' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save field' }));
    expect(within(dialog).getByRole('alert').textContent).toBe('A field with this name already exists');
    fireEvent.change(name, { target: { value: 'Valor' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save field' }));
    expect(within(dialog).getByRole('alert').textContent).toMatch(/^This name is used by a number of the deal/);
    expect(createDealField).not.toHaveBeenCalled();
  });

  it('formula: validates as typed, previews with sample numbers, inserts a field, saves the stored text', async () => {
    render(<DealFieldsSettings />);
    fireEvent.click(await screen.findByRole('button', { name: 'New deal field' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Field name'), { target: { value: 'Lucro' } });
    fireEvent.change(within(dialog).getByLabelText('Type'), { target: { value: 'formula' } });
    const box = within(dialog).getByLabelText('Formula') as HTMLTextAreaElement;

    fireEvent.change(box, { target: { value: '{Valor} −' } });
    expect(within(dialog).getByRole('alert').textContent).toBe(
      'The calculation is incomplete: an operator is missing a number',
    );
    fireEvent.change(box, { target: { value: '{Nada} + 1' } });
    expect(within(dialog).getByRole('alert').textContent).toContain('This field does not exist');
    expect(within(dialog).getByRole('alert').textContent).toContain('"Nada"');
    // a formula cannot be inserted: only the number fields are offered
    expect(within(dialog).queryByRole('button', { name: 'Margem' })).toBeNull();

    fireEvent.change(box, { target: { value: '{Valor} − ' } });
    box.setSelectionRange(box.value.length, box.value.length);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Custo' }));
    expect(box.value).toBe('{Valor} − {Custo}');
    expect(within(dialog).queryByRole('alert')).toBeNull();
    // 1000 − 100: a plain number until the format says money
    expect(within(dialog).getByText('900')).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText('Result format'), { target: { value: 'currency' } });
    expect(within(dialog).getByText(/R\$\s900,00/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save field' }));
    await waitFor(() => expect(createDealField).toHaveBeenCalled());
    expect(vi.mocked(createDealField).mock.calls[0][2]).toEqual({
      name: 'Lucro',
      kind: 'formula',
      expression: `{valor} - {f:${CUSTO_ID}}`,
      result_format: 'currency',
      show_on_card: false,
    });
  });

  it('a formula is not saved while its text is invalid', async () => {
    render(<DealFieldsSettings />);
    fireEvent.click(await screen.findByRole('button', { name: 'New deal field' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Field name'), { target: { value: 'Lucro' } });
    fireEvent.change(within(dialog).getByLabelText('Type'), { target: { value: 'formula' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save field' }));
    expect(within(dialog).getByRole('alert').textContent).toBe('Type the formula');
    fireEvent.change(within(dialog).getByLabelText('Formula'), { target: { value: '(1 + 2' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save field' }));
    expect(createDealField).not.toHaveBeenCalled();
  });

  it('show on card: disabled when two others already use it', async () => {
    vi.mocked(listDealFields).mockResolvedValue([
      field({ id: 'a', name: 'A', show_on_card: true }),
      field({ id: 'b', name: 'B', show_on_card: true, position: 1 }),
      field({ id: 'c', name: 'C', position: 2 }),
    ]);
    render(<DealFieldsSettings />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit deal field: C' }));
    let dialog = await screen.findByRole('dialog');
    const box = within(dialog).getByLabelText('Show on the pipeline card') as HTMLInputElement;
    expect(box.disabled).toBe(true);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    // one that is already on the card can stay or leave
    fireEvent.click(screen.getByRole('button', { name: 'Edit deal field: A' }));
    dialog = await screen.findByRole('dialog');
    expect((within(dialog).getByLabelText('Show on the pipeline card') as HTMLInputElement).disabled).toBe(false);
  });

  it('editing a formula loads its text with current names and saves the stored one', async () => {
    render(<DealFieldsSettings />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit deal field: Margem' }));
    const dialog = await screen.findByRole('dialog');
    expect((within(dialog).getByLabelText('Formula') as HTMLTextAreaElement).value).toBe('{Valor} − {Custo}');
    expect((within(dialog).getByLabelText('Type') as HTMLSelectElement).disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText('Formula'), { target: { value: '{Valor} − {Custo} × 2' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save field' }));
    await waitFor(() => expect(updateDealField).toHaveBeenCalled());
    expect(updateDealField).toHaveBeenCalledWith(expect.anything(), MARGEM.id, {
      name: 'Margem',
      expression: `{valor} - {f:${CUSTO_ID}} * 2`,
      result_format: 'currency',
      show_on_card: false,
    });
  });

  it('deleting a field used by a formula warns which formulas will stop working', async () => {
    render(<DealFieldsSettings />);
    fireEvent.click(await screen.findByRole('button', { name: 'Delete field: Custo' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('These formulas use this field and will stop working until you edit them:')).toBeTruthy();
    expect(within(dialog).getByText('Margem')).toBeTruthy();
    expect(deleteDealField).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete field' }));
    await waitFor(() => expect(deleteDealField).toHaveBeenCalledWith(expect.anything(), CUSTO_ID));
  });

  it('deleting a field nothing uses shows no formula warning', async () => {
    render(<DealFieldsSettings />);
    fireEvent.click(await screen.findByRole('button', { name: 'Delete field: Margem' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).queryByRole('alert')).toBeNull();
  });

  it('moves a field down', async () => {
    render(<DealFieldsSettings />);
    fireEvent.click(await screen.findByRole('button', { name: 'Move down: Custo' }));
    await waitFor(() => expect(reorderDealFields).toHaveBeenCalled());
    expect(vi.mocked(reorderDealFields).mock.calls[0][2]).toEqual([MARGEM.id, CUSTO_ID]);
    expect((screen.getByRole('button', { name: 'Move up: Custo' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('an agent sees the fields but no way to change them', async () => {
    h.canEdit = false;
    render(<DealFieldsSettings />);
    expect(await screen.findByText('Custo')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'New deal field' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Edit deal field|Delete field|Move up|Move down/ })).toBeNull();
  });

  it('a read-only (billing) account cannot change them either', async () => {
    h.readOnly = true;
    render(<DealFieldsSettings />);
    await screen.findByText('Custo');
    expect(screen.queryByRole('button', { name: 'New deal field' })).toBeNull();
  });

  it('empty state and retry', async () => {
    vi.mocked(listDealFields).mockResolvedValueOnce([]);
    const first = render(<DealFieldsSettings />);
    expect(await screen.findByText('No deal fields yet')).toBeTruthy();
    first.unmount();
    vi.mocked(listDealFields).mockRejectedValueOnce(new Error('offline'));
    render(<DealFieldsSettings />);
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Custo')).toBeTruthy();
  });

  it('disables the button at 50 fields', async () => {
    vi.mocked(listDealFields).mockResolvedValue(
      Array.from({ length: 50 }, (_, i) => field({ id: `id${i}`, name: `N${i}`, kind: 'number', position: i })),
    );
    render(<DealFieldsSettings />);
    const btn = (await screen.findByRole('button', { name: 'New deal field' })) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });
});

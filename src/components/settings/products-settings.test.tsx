// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { toast } from 'sonner';

import type { Product } from '@/lib/products/types';

const h = vi.hoisted(() => ({ canEdit: true, readOnly: false }));

vi.mock('@/hooks/use-language', () => ({ useLanguage: () => ({ t: (s: string) => s, language: 'pt-BR' }) }));
vi.mock('@/hooks/use-auth', () => ({ useAuth: () => ({ accountId: 'acc-1', defaultCurrency: 'BRL' }) }));
vi.mock('@/hooks/use-can', () => ({ useCan: () => h.canEdit }));
vi.mock('@/hooks/use-read-only', () => ({ useReadOnly: () => ({ readOnly: h.readOnly }) }));
vi.mock('@/lib/supabase/client', () => ({ createClient: () => ({}) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/products/data', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/products/data')>()),
  listProducts: vi.fn(),
  createProduct: vi.fn(),
  updateProduct: vi.fn(),
  setProductArchived: vi.fn(),
}));

import { createProduct, listProducts, setProductArchived, updateProduct } from '@/lib/products/data';
import { ProductsSettings } from './products-settings';

const product = (over: Partial<Product> = {}): Product => ({
  id: 'p1',
  account_id: 'acc-1',
  name: 'Plano Mensal',
  code: 'PM',
  unit_price: 99.9,
  description: 'Acesso por 30 dias',
  archived_at: null,
  ...over,
});

beforeEach(() => {
  h.canEdit = true;
  h.readOnly = false;
  vi.mocked(listProducts).mockResolvedValue([
    product(),
    product({ id: 'p2', name: 'Taxa antiga', code: null, description: null, unit_price: 10, archived_at: '2026-10-01T00:00:00Z' }),
  ]);
  vi.mocked(createProduct).mockResolvedValue(undefined);
  vi.mocked(updateProduct).mockResolvedValue(undefined);
  vi.mocked(setProductArchived).mockResolvedValue(undefined);
});
afterEach(cleanup);

describe('ProductsSettings', () => {
  it('lists active and archived products with prices in cents', async () => {
    render(<ProductsSettings />);
    expect(await screen.findByText('Plano Mensal')).toBeTruthy();
    expect(screen.getByText(/R\$\s99,90/)).toBeTruthy();
    expect(screen.getByText('Acesso por 30 dias')).toBeTruthy();
    expect(screen.getByText('Archived products')).toBeTruthy();
    expect(screen.getByText('Taxa antiga')).toBeTruthy();
    expect(listProducts).toHaveBeenCalledWith(expect.anything(), { includeArchived: true });
  });

  it('an admin can create, edit and archive', async () => {
    render(<ProductsSettings />);
    expect(await screen.findByRole('button', { name: 'New product or service' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Edit product or service: Plano Mensal' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Archive product: Plano Mensal' }));
    await waitFor(() => expect(setProductArchived).toHaveBeenCalledWith(expect.anything(), 'p1', true));
    fireEvent.click(screen.getByRole('button', { name: 'Restore product: Taxa antiga' }));
    await waitFor(() => expect(setProductArchived).toHaveBeenCalledWith(expect.anything(), 'p2', false));
  });

  it('creates a product from pt-BR input', async () => {
    render(<ProductsSettings />);
    fireEvent.click(await screen.findByRole('button', { name: 'New product or service' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Product or service name'), { target: { value: ' Instalação ' } });
    fireEvent.change(within(dialog).getByLabelText('Price per unit'), { target: { value: 'R$ 1.500,50' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save product' }));
    await waitFor(() => expect(createProduct).toHaveBeenCalled());
    expect(createProduct).toHaveBeenCalledWith(expect.anything(), 'acc-1', {
      name: 'Instalação',
      code: null,
      unit_price: 1500.5,
      description: null,
    });
    expect(toast.success).toHaveBeenCalledWith('Product created');
  });

  it('shows field errors with aria-invalid and does not save', async () => {
    render(<ProductsSettings />);
    fireEvent.click(await screen.findByRole('button', { name: 'New product or service' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Price per unit'), { target: { value: 'abc' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save product' }));
    expect(within(dialog).getByLabelText('Product or service name').getAttribute('aria-invalid')).toBe('true');
    expect(within(dialog).getByLabelText('Price per unit').getAttribute('aria-invalid')).toBe('true');
    expect(within(dialog).getAllByRole('alert')).toHaveLength(2);
    expect(createProduct).not.toHaveBeenCalled();
  });

  it('reports a duplicate name from the database and keeps the dialog open', async () => {
    vi.mocked(createProduct).mockRejectedValue({ code: '23505', message: 'dup' });
    render(<ProductsSettings />);
    fireEvent.click(await screen.findByRole('button', { name: 'New product or service' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Product or service name'), { target: { value: 'Plano Mensal' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save product' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('A product with this name already exists'));
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('edits an existing product with its current values', async () => {
    render(<ProductsSettings />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit product or service: Plano Mensal' }));
    const dialog = await screen.findByRole('dialog');
    expect((within(dialog).getByLabelText('Price per unit') as HTMLInputElement).value).toBe('99,9');
    fireEvent.change(within(dialog).getByLabelText('Price per unit'), { target: { value: '120' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save product' }));
    await waitFor(() => expect(updateProduct).toHaveBeenCalledWith(expect.anything(), 'p1', expect.objectContaining({ unit_price: 120, name: 'Plano Mensal' })));
  });

  it('an agent reads the catalog but sees no way to change it', async () => {
    h.canEdit = false;
    render(<ProductsSettings />);
    expect(await screen.findByText('Plano Mensal')).toBeTruthy();
    expect(screen.getByText('Only owners and admins can change the catalog.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'New product or service' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Edit product or service/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Archive product|Restore product/ })).toBeNull();
  });

  it('a read-only (billing) account cannot change it either', async () => {
    h.readOnly = true;
    render(<ProductsSettings />);
    await screen.findByText('Plano Mensal');
    expect(screen.queryByRole('button', { name: 'New product or service' })).toBeNull();
  });

  it('empty state: invites an admin to add the first product, tells an agent to ask an admin', async () => {
    vi.mocked(listProducts).mockResolvedValue([]);
    const { unmount } = render(<ProductsSettings />);
    expect(await screen.findByText('No products or services yet')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add your first product' })).toBeTruthy();
    unmount();
    h.canEdit = false;
    render(<ProductsSettings />);
    expect(await screen.findByText('An owner or admin can register what you sell.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Add your first product' })).toBeNull();
  });

  it('offers a retry when the catalog cannot be loaded', async () => {
    vi.mocked(listProducts).mockRejectedValueOnce(new Error('offline'));
    render(<ProductsSettings />);
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Plano Mensal')).toBeTruthy();
  });
});

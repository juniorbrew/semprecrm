// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, renderHook, waitFor } from '@testing-library/react';

import type { DealField } from '@/lib/deal-fields/types';
import type { Deal, PipelineStage } from '@/types';

const h = vi.hoisted(() => ({ pipelines: true, ready: true }));

vi.mock('@/hooks/use-auth', () => ({
  useAuth: () => ({ defaultCurrency: 'BRL' }),
  useEntitlements: () => ({ ready: h.ready, modules: { pipelines: h.pipelines } }),
}));
vi.mock('@/lib/supabase/client', () => ({ createClient: () => ({}) }));
vi.mock('@/lib/deal-fields/events', () => ({ onDealFieldsChanged: vi.fn(() => () => {}) }));
vi.mock('@/lib/deal-fields/data', () => ({
  listDealFields: vi.fn(),
  listValuesForDeals: vi.fn(),
  listItemSums: vi.fn(),
}));

import { listDealFields, listItemSums, listValuesForDeals } from '@/lib/deal-fields/data';
import { useCardFieldLines } from './use-card-field-lines';

const CUSTO = '11111111-1111-4111-8111-111111111111';
const FRETE = '22222222-2222-4222-8222-222222222222';
const base = { account_id: 'a', expression: null, result_format: null } as const;
const custo = (card: boolean): DealField => ({ ...base, id: CUSTO, name: 'Custo', kind: 'currency', show_on_card: card, position: 0 });
const frete: DealField = { ...base, id: FRETE, name: 'Frete', kind: 'number', show_on_card: false, position: 1 };
const margem = (expression: string): DealField => ({
  ...base,
  id: '33333333-3333-4333-8333-333333333333',
  name: 'Margem',
  kind: 'formula',
  expression,
  result_format: 'currency',
  show_on_card: true,
  position: 2,
});

const stages = [
  { id: 's1', name: 'A', position: 0, win_probability: 50 },
  { id: 's2', name: 'B', position: 1, win_probability: null },
] as PipelineStage[];
const deals = [
  { id: 'd1', stage_id: 's1', value: 1000, currency: 'BRL' },
  { id: 'd2', stage_id: 's1', value: 2000, currency: 'BRL' },
] as Deal[];

beforeEach(() => {
  h.pipelines = true;
  h.ready = true;
  vi.mocked(listValuesForDeals).mockResolvedValue({ d1: { [CUSTO]: 300 } });
  vi.mocked(listItemSums).mockResolvedValue({ d1: 800 });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('useCardFieldLines', () => {
  it('gives each deal its card fields, "—" when empty, loading only the fields they need', async () => {
    vi.mocked(listDealFields).mockResolvedValue([custo(true), frete, margem(`{valor} - {f:${CUSTO}}`)]);
    const { result } = renderHook(() => useCardFieldLines(deals, stages));
    await waitFor(() => expect(result.current.get('d1')).toBeTruthy());
    // only two fields fit on the card: Custo and Margem (Frete is not marked)
    expect(result.current.get('d1')).toEqual([
      { id: CUSTO, name: 'Custo', text: expect.stringMatching(/R\$\s300$/) },
      { id: '33333333-3333-4333-8333-333333333333', name: 'Margem', text: expect.stringMatching(/R\$\s700$/) },
    ]);
    expect(result.current.get('d2')?.map((l) => l.text)).toEqual(['—', '—']);
    expect(listValuesForDeals).toHaveBeenCalledTimes(1);
    expect(listValuesForDeals).toHaveBeenCalledWith(expect.anything(), ['d1', 'd2'], [CUSTO]);
    expect(listItemSums).not.toHaveBeenCalled();
  });

  it('reads the item sums only when a card formula uses {Itens}, and {Chance} follows the stage', async () => {
    vi.mocked(listDealFields).mockResolvedValue([margem('{itens} * {chance}')]);
    const { result } = renderHook(() => useCardFieldLines(deals, stages));
    await waitFor(() => expect(result.current.get('d1')).toBeTruthy());
    expect(listItemSums).toHaveBeenCalledWith(expect.anything(), ['d1', 'd2']);
    // 800 x 50%; d2 has no items: 0 x 50%
    expect(result.current.get('d1')?.[0].text).toMatch(/R\$\s400$/);
    expect(result.current.get('d2')?.[0].text).toMatch(/R\$\s0$/);
  });

  it('does nothing without the module or without a card field', async () => {
    vi.mocked(listDealFields).mockResolvedValue([custo(false)]);
    const a = renderHook(() => useCardFieldLines(deals, stages));
    await waitFor(() => expect(listDealFields).toHaveBeenCalled());
    expect(a.result.current.size).toBe(0);
    expect(listValuesForDeals).not.toHaveBeenCalled();
    a.unmount();
    vi.clearAllMocks();
    h.pipelines = false;
    const b = renderHook(() => useCardFieldLines(deals, stages));
    expect(b.result.current.size).toBe(0);
    expect(listDealFields).not.toHaveBeenCalled();
  });

  it('a failed read leaves the cards as they were', async () => {
    vi.mocked(listDealFields).mockResolvedValue([custo(true)]);
    vi.mocked(listValuesForDeals).mockRejectedValue(new Error('offline'));
    const { result } = renderHook(() => useCardFieldLines(deals, stages));
    await waitFor(() => expect(listValuesForDeals).toHaveBeenCalled());
    expect(result.current.size).toBe(0);
  });
});

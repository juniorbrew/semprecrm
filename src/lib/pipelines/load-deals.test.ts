import { describe, expect, it, vi } from 'vitest';

import { DEAL_BOARD_SELECT, DEAL_BOARD_SELECT_FALLBACK, loadPipelineDeals } from './load-deals';

type Answer = { data: unknown; error: { message: string } | null };

function fakeDb(answers: Answer[]) {
  const selects: string[] = [];
  const db = {
    from: () => {
      const b = {
        select: (cols: string) => {
          selects.push(cols);
          return b;
        },
        eq: () => b,
        order: async () => answers.shift()!,
      };
      return b;
    },
  };
  return { db: db as never, selects };
}

describe('loadPipelineDeals', () => {
  it('embeds the company when the database has it', async () => {
    const { db, selects } = fakeDb([{ data: [{ id: 'd1', company: null }], error: null }]);
    expect(await loadPipelineDeals(db, 'p1')).toEqual({ deals: [{ id: 'd1', company: null }], problem: null });
    expect(selects).toEqual([DEAL_BOARD_SELECT]);
  });

  it('falls back to the select without companies instead of emptying the board', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { db, selects } = fakeDb([
      { data: null, error: { message: "Could not find a relationship between 'deals' and 'companies'" } },
      { data: [{ id: 'd1' }], error: null },
    ]);
    expect(await loadPipelineDeals(db, 'p1')).toEqual({ deals: [{ id: 'd1' }], problem: 'degraded' });
    expect(selects).toEqual([DEAL_BOARD_SELECT, DEAL_BOARD_SELECT_FALLBACK]);
    expect(DEAL_BOARD_SELECT_FALLBACK).not.toContain('companies');
    spy.mockRestore();
  });

  it('reports a total failure', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { db } = fakeDb([
      { data: null, error: { message: 'boom' } },
      { data: null, error: { message: 'boom' } },
    ]);
    expect(await loadPipelineDeals(db, 'p1')).toEqual({ deals: [], problem: 'failed' });
    spy.mockRestore();
  });
});

import { describe, expect, it } from 'vitest';

import { summarizeUsage, type UsageRow } from './usage-breakdown';

const row = (over: Partial<UsageRow>): UsageRow => ({
  created_at: '2026-10-03T15:00:00Z',
  feature: 'auto_reply',
  model: 'm1',
  status: 'ok',
  input_tokens: 100,
  output_tokens: 50,
  cost_cents: '0.5',
  ...over,
});

describe('summarizeUsage', () => {
  it('sums calls, errors, tokens and cost per bucket and accepts numeric strings', () => {
    const out = summarizeUsage([row({}), row({ status: 'error', cost_cents: 0.25 }), row({ feature: 'suggest_reply', cost_cents: 2 })]);
    expect(out.byFeature[0]).toMatchObject({ key: 'suggest_reply', calls: 1, costCents: 2 });
    expect(out.byFeature[1]).toMatchObject({ key: 'auto_reply', calls: 2, errors: 1, tokens: 300, costCents: 0.75 });
  });

  it('groups days in the São Paulo calendar, ascending', () => {
    // 01:00Z on 04/10 is still 03/10 at 22:00 in São Paulo.
    const out = summarizeUsage([
      row({ created_at: '2026-10-04T01:00:00Z' }),
      row({ created_at: '2026-10-03T12:00:00Z' }),
      row({ created_at: '2026-10-04T12:00:00Z' }),
    ]);
    expect(out.byDay.map((d) => [d.key, d.calls])).toEqual([
      ['2026-10-03', 2],
      ['2026-10-04', 1],
    ]);
  });

  it('is empty-safe', () => {
    expect(summarizeUsage([])).toEqual({ byDay: [], byFeature: [], byModel: [] });
  });
});

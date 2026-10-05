// Month usage broken down for /ai/uso. Pure: the route feeds it the
// ledger rows (`ai_usage`, ok/error only) and the page renders the result.

import { AI_BUDGET_TIME_ZONE } from './budget';

export interface UsageRow {
  created_at: string;
  feature: string;
  model: string;
  status: string;
  input_tokens: number | string | null;
  output_tokens: number | string | null;
  cost_cents: number | string | null;
}

export interface UsageBucket {
  key: string;
  calls: number;
  errors: number;
  tokens: number;
  costCents: number;
}

export interface UsageBreakdown {
  byDay: UsageBucket[];
  byFeature: UsageBucket[];
  byModel: UsageBucket[];
}

const num = (v: unknown) => {
  const x = typeof v === 'number' ? v : Number(v ?? 0);
  return Number.isFinite(x) ? x : 0;
};

const dayFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: AI_BUDGET_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

function add(map: Map<string, UsageBucket>, key: string, row: UsageRow) {
  const b = map.get(key) ?? { key, calls: 0, errors: 0, tokens: 0, costCents: 0 };
  b.calls += 1;
  if (row.status === 'error') b.errors += 1;
  b.tokens += num(row.input_tokens) + num(row.output_tokens);
  b.costCents += num(row.cost_cents);
  map.set(key, b);
}

/** Days ascending; features and models by cost, highest first. */
export function summarizeUsage(rows: UsageRow[]): UsageBreakdown {
  const days = new Map<string, UsageBucket>();
  const features = new Map<string, UsageBucket>();
  const models = new Map<string, UsageBucket>();
  for (const row of rows) {
    add(days, dayFmt.format(new Date(row.created_at)), row);
    add(features, row.feature, row);
    add(models, row.model, row);
  }
  const byCost = (a: UsageBucket, b: UsageBucket) => b.costCents - a.costCents || b.calls - a.calls;
  return {
    byDay: [...days.values()].sort((a, b) => a.key.localeCompare(b.key)),
    byFeature: [...features.values()].sort(byCost),
    byModel: [...models.values()].sort(byCost),
  };
}

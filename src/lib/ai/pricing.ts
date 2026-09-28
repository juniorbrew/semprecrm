// ============================================================
// Model pricing — USD cents per 1M tokens (input / output).
//
// A small hand-kept table for the models the Settings picker suggests
// plus their close relatives. Lookup is exact first, then the longest
// known prefix (so dated snapshots like `gpt-4o-mini-2024-07-18` or
// `claude-haiku-4-5-20251001` resolve to their family). An unknown
// model is charged at a deliberately HIGH default so the monthly
// budget errs on the side of stopping early, never of spending more
// than the admin allowed.
//
// Prices are the providers' public list prices; review when adding a
// model. Costs are estimates for the budget guard — the provider's
// invoice is the source of truth.
// ============================================================

export interface ModelPrice {
  /** USD cents per 1M input tokens. */
  input: number;
  /** USD cents per 1M output tokens. */
  output: number;
}

export const MODEL_PRICES: Readonly<Record<string, ModelPrice>> = {
  // OpenAI
  'gpt-4o-mini': { input: 15, output: 60 },
  'gpt-4o': { input: 250, output: 1000 },
  'gpt-4.1-nano': { input: 10, output: 40 },
  'gpt-4.1-mini': { input: 40, output: 160 },
  'gpt-4.1': { input: 200, output: 800 },
  'gpt-5-nano': { input: 5, output: 40 },
  'gpt-5-mini': { input: 25, output: 200 },
  'gpt-5': { input: 125, output: 1000 },
  // Anthropic
  'claude-haiku-4-5': { input: 100, output: 500 },
  'claude-3-5-haiku': { input: 80, output: 400 },
  'claude-sonnet-5': { input: 200, output: 1000 },
  'claude-sonnet-4-6': { input: 300, output: 1500 },
  'claude-sonnet-4-5': { input: 300, output: 1500 },
  'claude-sonnet-4': { input: 300, output: 1500 },
  'claude-opus-5-5': { input: 400, output: 2000 },
  'claude-opus-5': { input: 500, output: 2500 },
  'claude-opus-4': { input: 500, output: 2500 },
};

/** Conservative price for models not in the table. */
export const UNKNOWN_MODEL_PRICE: ModelPrice = { input: 1000, output: 5000 };

export function resolveModelPrice(model: string): { price: ModelPrice; known: boolean } {
  const id = model.trim().toLowerCase();
  const exact = MODEL_PRICES[id];
  if (exact) return { price: exact, known: true };
  let best: string | null = null;
  for (const key of Object.keys(MODEL_PRICES)) {
    if (id.startsWith(`${key}-`) && (best === null || key.length > best.length)) {
      best = key;
    }
  }
  if (best) return { price: MODEL_PRICES[best], known: true };
  return { price: UNKNOWN_MODEL_PRICE, known: false };
}

/**
 * Cost of one call in USD cents, rounded UP to 4 decimals (the
 * precision of `ai_usage.cost_cents`) so tiny calls never read as free.
 */
export function computeCostCents(model: string, inputTokens: number, outputTokens: number): number {
  const { price } = resolveModelPrice(model);
  const inTok = Number.isFinite(inputTokens) && inputTokens > 0 ? inputTokens : 0;
  const outTok = Number.isFinite(outputTokens) && outputTokens > 0 ? outputTokens : 0;
  const raw = (inTok * price.input + outTok * price.output) / 1_000_000;
  if (raw <= 0) return 0;
  return Math.ceil(raw * 10_000 - 1e-9) / 10_000;
}

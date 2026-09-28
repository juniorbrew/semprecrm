// ============================================================
// Model pricing — USD cents per 1M tokens (input / output).
//
// A hand-kept table. Lookup is EXACT, plus dated snapshots of a known
// id (`gpt-4o-mini-2024-07-18`, `claude-opus-4-1-20250805`) and the
// `-latest` alias. There is deliberately no generic prefix fallback:
// `gpt-5-pro` must never be priced as `gpt-5`, nor `claude-opus-4-1`
// as `claude-opus-4`. Anything not in the table is charged at a VERY
// high rate so the monthly budget stops early rather than letting an
// expensive unknown model spend more than the admin allowed.
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
  // ---- OpenAI ------------------------------------------------------------
  'gpt-3.5-turbo': { input: 50, output: 150 },
  'gpt-4': { input: 3000, output: 6000 },
  'gpt-4-turbo': { input: 1000, output: 3000 },
  'gpt-4o-mini': { input: 15, output: 60 },
  'gpt-4o': { input: 250, output: 1000 },
  'gpt-4.1-nano': { input: 10, output: 40 },
  'gpt-4.1-mini': { input: 40, output: 160 },
  'gpt-4.1': { input: 200, output: 800 },
  'gpt-5-nano': { input: 5, output: 40 },
  'gpt-5-mini': { input: 25, output: 200 },
  'gpt-5': { input: 125, output: 1000 },
  'gpt-5-pro': { input: 1500, output: 12000 },
  'o1-mini': { input: 110, output: 440 },
  'o1': { input: 1500, output: 6000 },
  'o1-pro': { input: 15000, output: 60000 },
  'o3-mini': { input: 110, output: 440 },
  'o3': { input: 200, output: 800 },
  'o3-pro': { input: 2000, output: 8000 },
  'o4-mini': { input: 110, output: 440 },
  // ---- Anthropic ---------------------------------------------------------
  'claude-3-haiku': { input: 25, output: 125 },
  'claude-3-5-haiku': { input: 80, output: 400 },
  'claude-haiku-4-5': { input: 100, output: 500 },
  'claude-3-5-sonnet': { input: 300, output: 1500 },
  'claude-3-7-sonnet': { input: 300, output: 1500 },
  'claude-sonnet-4': { input: 300, output: 1500 },
  'claude-sonnet-4-0': { input: 300, output: 1500 },
  'claude-sonnet-4-5': { input: 300, output: 1500 },
  'claude-sonnet-4-6': { input: 300, output: 1500 },
  'claude-sonnet-5': { input: 200, output: 1000 },
  'claude-3-opus': { input: 1500, output: 7500 },
  'claude-opus-4': { input: 1500, output: 7500 },
  'claude-opus-4-0': { input: 1500, output: 7500 },
  'claude-opus-4-1': { input: 1500, output: 7500 },
  'claude-opus-4-5': { input: 500, output: 2500 },
  'claude-opus-4-6': { input: 500, output: 2500 },
  'claude-opus-4-7': { input: 500, output: 2500 },
  'claude-opus-4-8': { input: 500, output: 2500 },
  'claude-opus-5': { input: 500, output: 2500 },
  'claude-opus-5-5': { input: 400, output: 2000 },
  'claude-fable-5': { input: 1000, output: 5000 },
  'claude-fable-5-1': { input: 1000, output: 5000 },
};

/** Price for models not in the table — above every known model. */
export const UNKNOWN_MODEL_PRICE: ModelPrice = { input: 15000, output: 60000 };

// `-2024-07-18`, `-20250805`, `-latest`.
const SNAPSHOT_SUFFIX = /-(?:\d{4}-\d{2}-\d{2}|\d{8}|latest)$/;

export function resolveModelPrice(model: string): { price: ModelPrice; known: boolean } {
  const id = model.trim().toLowerCase();
  const exact = MODEL_PRICES[id];
  if (exact) return { price: exact, known: true };
  const base = id.replace(SNAPSHOT_SUFFIX, '');
  if (base !== id && MODEL_PRICES[base]) return { price: MODEL_PRICES[base], known: true };
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

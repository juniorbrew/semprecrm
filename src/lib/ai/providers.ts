// ============================================================
// AI providers and models — pure, safe to import from the client.
//
// Each account brings its own API key for one of these providers
// (migration 058). There is no platform key and no env fallback.
// ============================================================

export const AI_PROVIDERS = ['openai', 'anthropic'] as const;
export type AiProvider = (typeof AI_PROVIDERS)[number];

export const AI_PROVIDER_LABELS: Record<AiProvider, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
};

/** Where the admin gets a key — shown as a link in Settings. */
export const AI_PROVIDER_KEY_URLS: Record<AiProvider, string> = {
  openai: 'https://platform.openai.com/api-keys',
  anthropic: 'https://console.anthropic.com/settings/keys',
};

/** Cheap, fast models suited to short reply suggestions. */
export const AI_DEFAULT_MODELS: Record<AiProvider, string> = {
  openai: 'gpt-4.1-mini',
  anthropic: 'claude-haiku-4-5',
};

/** Suggestions for the model picker; any other id can be typed in. */
export const AI_SUGGESTED_MODELS: Record<AiProvider, readonly string[]> = {
  openai: ['gpt-4.1-mini', 'gpt-4o-mini', 'gpt-4.1-nano', 'gpt-4.1', 'gpt-4o'],
  anthropic: ['claude-haiku-4-5', 'claude-sonnet-5', 'claude-sonnet-4-6'],
};

/** Mirrors `ai_settings_model_check` in migration 058. */
const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$/;

export function isAiProvider(value: unknown): value is AiProvider {
  return typeof value === 'string' && (AI_PROVIDERS as readonly string[]).includes(value);
}

export function isValidModelId(value: unknown): value is string {
  return typeof value === 'string' && MODEL_ID_RE.test(value);
}

/**
 * Does this model id belong to the provider? Anthropic ids all start
 * with `claude-`; OpenAI ids never do. Catches "claude-haiku-4-5 with
 * an OpenAI key" before it becomes a confusing 404 at suggest time.
 */
export function modelMatchesProvider(provider: AiProvider, model: string): boolean {
  const isClaude = /^claude-/i.test(model.trim());
  return provider === 'anthropic' ? isClaude : !isClaude;
}

/**
 * Parse a US$ amount typed in the budget field into cents. Accepts
 * pt-BR ("1.000,50", "10,5") and en ("1000.50", "1,000.50") forms and
 * an optional "US$"/"$" prefix. Returns null when it isn't a valid,
 * non-negative amount within the allowed range.
 */
export function parseBudgetInput(raw: string): number | null {
  let v = raw.trim().replace(/^(us)?\$\s*/i, '').replace(/\s+/g, '');
  if (!v) return null;
  const lastComma = v.lastIndexOf(',');
  const lastDot = v.lastIndexOf('.');
  if (lastComma >= 0 && lastComma > lastDot) {
    // pt-BR: dots are thousands, comma is the decimal separator.
    v = v.replace(/\./g, '').replace(',', '.');
  } else if (lastDot >= 0 && lastComma >= 0) {
    // en with thousands commas: 1,000.50
    v = v.replace(/,/g, '');
  } else if (/^\d{1,3}(\.\d{3})+$/.test(v)) {
    // "1.000" / "12.500" — pt-BR thousands without decimals.
    v = v.replace(/\./g, '');
  }
  if (!/^\d+(\.\d{1,2})?$/.test(v)) return null;
  const cents = Math.round(Number(v) * 100);
  return Number.isFinite(cents) && cents >= 0 && cents <= AI_LIMITS.budgetMaxCents ? cents : null;
}

/** Limits shared by the settings API, the UI and the DB constraints. */
export const AI_LIMITS = {
  instructionsMaxChars: 4000,
  budgetMaxCents: 1_000_000,
  historyMin: 1,
  historyMax: 50,
  historyDefault: 20,
  budgetDefaultCents: 1000,
} as const;

/** Features recorded in `ai_usage.feature`. */
export type AiFeature = 'suggest_reply';

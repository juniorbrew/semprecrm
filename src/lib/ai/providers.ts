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

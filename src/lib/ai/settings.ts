// ============================================================
// AI settings — validation of the Settings → IA form (pure).
//
// The DB enforces the same invariants (migration 058 CHECKs); this
// layer turns them into readable errors and applies the product
// rules the DB can't see (a key must exist to enable).
// ============================================================

import { AI_DEFAULT_MODELS, AI_LIMITS, isAiProvider, isValidModelId, type AiProvider } from './providers';
import type { AiSettingsRow } from './store';

export const AI_SETTINGS_ERRORS = {
  body: 'Body must be a JSON object',
  provider: 'Unknown AI provider',
  model: 'Invalid model id',
  instructions: 'Instructions must be text of at most 4000 characters',
  budget: 'The monthly budget must be a whole number of cents between 0 and 1000000',
  history: 'The number of messages must be between 1 and 50',
  enabled: "'enabled' must be true or false",
  consentNeedsProvider: 'Choose a provider before accepting the data-processing notice',
  needsProviderModel: 'Choose a provider and a model before enabling AI',
  needsConsent: 'Accept the data-processing notice for this provider before enabling AI',
  needsKey: 'Save a valid API key for this provider before enabling AI',
} as const;

/** Columns the route writes (consent stamp fields are set by the DB trigger). */
export interface AiSettingsWrite {
  enabled: boolean;
  provider: AiProvider | null;
  model: string | null;
  instructions: string | null;
  monthly_budget_cents: number;
  suggest_history_messages: number;
  consent_provider: AiProvider | null;
  consented_at: string | null;
}

export type AiSettingsParse =
  | { ok: true; write: AiSettingsWrite; consentChanged: boolean }
  | { ok: false; error: string };

function isInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v);
}

/**
 * Merge a PUT body over the current row. `keyProviders` = providers
 * that have a saved key for this account. `now` stamps a new consent
 * (the DB trigger re-stamps it with its own clock anyway).
 */
export function parseAiSettingsUpdate(
  current: AiSettingsRow | null,
  body: unknown,
  keyProviders: ReadonlySet<AiProvider>,
  now: Date = new Date(),
): AiSettingsParse {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: AI_SETTINGS_ERRORS.body };
  }
  const b = body as Record<string, unknown>;

  let provider: AiProvider | null = current?.provider ?? null;
  if ('provider' in b) {
    if (b.provider === null || b.provider === '') provider = null;
    else if (isAiProvider(b.provider)) provider = b.provider;
    else return { ok: false, error: AI_SETTINGS_ERRORS.provider };
  }

  let model: string | null = current?.model ?? null;
  if ('model' in b) {
    const raw = typeof b.model === 'string' ? b.model.trim() : b.model;
    if (raw === null || raw === '') model = null;
    else if (isValidModelId(raw)) model = raw;
    else return { ok: false, error: AI_SETTINGS_ERRORS.model };
  }
  // Provider switched and the model belongs to the other family (or is
  // empty): fall back to the new provider's default.
  if (provider && (!model || ('provider' in b && provider !== current?.provider && !('model' in b)))) {
    model = AI_DEFAULT_MODELS[provider];
  }

  let instructions: string | null = current?.instructions ?? null;
  if ('instructions' in b) {
    if (b.instructions === null) instructions = null;
    else if (typeof b.instructions === 'string' && b.instructions.length <= AI_LIMITS.instructionsMaxChars) {
      instructions = b.instructions.trim() || null;
    } else return { ok: false, error: AI_SETTINGS_ERRORS.instructions };
  }

  let budget = current?.monthly_budget_cents ?? AI_LIMITS.budgetDefaultCents;
  if ('monthly_budget_cents' in b) {
    if (!isInt(b.monthly_budget_cents) || b.monthly_budget_cents < 0 || b.monthly_budget_cents > AI_LIMITS.budgetMaxCents) {
      return { ok: false, error: AI_SETTINGS_ERRORS.budget };
    }
    budget = b.monthly_budget_cents;
  }

  let history = current?.suggest_history_messages ?? AI_LIMITS.historyDefault;
  if ('suggest_history_messages' in b) {
    const h = b.suggest_history_messages;
    if (!isInt(h) || h < AI_LIMITS.historyMin || h > AI_LIMITS.historyMax) {
      return { ok: false, error: AI_SETTINGS_ERRORS.history };
    }
    history = h;
  }

  let consentProvider: AiProvider | null = current?.consent_provider ?? null;
  let consentedAt: string | null = current?.consented_at ?? null;
  let consentChanged = false;
  if ('accept_consent' in b) {
    if (b.accept_consent === true) {
      if (!provider) return { ok: false, error: AI_SETTINGS_ERRORS.consentNeedsProvider };
      if (consentProvider !== provider || !consentedAt) {
        consentProvider = provider;
        consentedAt = now.toISOString();
        consentChanged = true;
      }
    } else if (b.accept_consent === false) {
      consentChanged = consentedAt !== null;
      consentProvider = null;
      consentedAt = null;
    }
  }

  let enabled = current?.enabled ?? false;
  if ('enabled' in b) {
    if (typeof b.enabled !== 'boolean') return { ok: false, error: AI_SETTINGS_ERRORS.enabled };
    enabled = b.enabled;
  }

  const consentValid = !!consentedAt && !!provider && consentProvider === provider;
  if (enabled) {
    const askedToEnable = b.enabled === true;
    const problem = !provider || !model
      ? AI_SETTINGS_ERRORS.needsProviderModel
      : !consentValid
        ? AI_SETTINGS_ERRORS.needsConsent
        : !keyProviders.has(provider)
          ? AI_SETTINGS_ERRORS.needsKey
          : null;
    if (problem) {
      // Explicitly asked to turn on → tell them why not. Otherwise an
      // unrelated edit (e.g. switching provider) silently turns it off.
      if (askedToEnable) return { ok: false, error: problem };
      enabled = false;
    }
  }

  return {
    ok: true,
    consentChanged,
    write: {
      enabled,
      provider,
      model,
      instructions,
      monthly_budget_cents: budget,
      suggest_history_messages: history,
      consent_provider: consentProvider,
      consented_at: consentedAt,
    },
  };
}

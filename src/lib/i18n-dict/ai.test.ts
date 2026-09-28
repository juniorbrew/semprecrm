import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { translateLiteral } from '@/lib/i18n';
import { AI_ERROR_MESSAGES } from '@/lib/ai/errors';
import { AI_SETTINGS_ERRORS } from '@/lib/ai/settings';
import { MODULE_LABELS } from '@/lib/plans';
import { DICT_AI } from './ai';

// Every English string the AI routes return, and every key the AI
// settings panel renders, must have a pt-BR entry (the DOM translator
// and `t()` match by exact string).
const KEYS = [
  ...Object.values(AI_ERROR_MESSAGES),
  ...Object.values(AI_SETTINGS_ERRORS).filter((m) => m !== AI_SETTINGS_ERRORS.body && m !== AI_SETTINGS_ERRORS.provider),
  'Unknown AI provider',
  'This does not look like an API key',
  'Failed to save the AI settings',
  'This contact was anonymized (LGPD) — AI suggestions are not available.',
  'There are no messages in this conversation to reply to yet.',
  MODULE_LABELS.ai,
];

describe('pt-BR dictionary — AI', () => {
  it.each(KEYS)('translates %s', (key) => {
    expect(translateLiteral(key, 'pt-BR')).not.toBe(key);
  });

  it('has no empty translations', () => {
    for (const [k, v] of Object.entries(DICT_AI)) expect(v.trim(), k).not.toBe('');
  });
});

// Every literal passed to t() in the AI settings panel.
const T_CALL = new RegExp(String.raw`\bt\(\s*(["'])(.*?)\1\s*,?\s*\)`, 'gs');
const PANEL_KEYS = (() => {
  const src = readFileSync(join(process.cwd(), 'src/components/settings/ai-settings.tsx'), 'utf8');
  const keys = new Set<string>();
  for (const m of src.matchAll(T_CALL)) keys.add(m[2]);
  return [...keys];
})();

describe('pt-BR dictionary — AI settings panel', () => {
  it('found the panel strings', () => {
    expect(PANEL_KEYS.length).toBeGreaterThan(40);
  });
  it.each(PANEL_KEYS)('translates %s', (key) => {
    expect(translateLiteral(key, 'pt-BR')).not.toBe(key);
  });
});

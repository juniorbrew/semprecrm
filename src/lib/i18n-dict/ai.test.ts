import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { translateLiteral } from '@/lib/i18n';
import { AI_ERROR_MESSAGES } from '@/lib/ai/errors';
import { AI_SETTINGS_ERRORS } from '@/lib/ai/settings';
import { KB_ERRORS } from '@/lib/ai/knowledge';
import { KB_EXTRACT_ERRORS } from '@/lib/ai/knowledge-extract';
import { AGENT_ERRORS } from '@/lib/ai/agents';
import { MEMORY_ERRORS } from '@/lib/ai/memory';
import { MODULE_LABELS } from '@/lib/plans';
import { AGENT_PRESETS } from '@/lib/ai/agent-presets';
import { CHANNEL_LABEL, MODE_LABEL, STATUS_LABEL } from '@/components/ai-agents/agent-card';
import { SAFETY_CHECKS } from '@/components/ai-agents/agent-config-form';
import { operationHelp } from '@/components/ai-agents/agent-operation-bar';
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
  ...Object.values(KB_ERRORS).filter((m) => m !== KB_ERRORS.body),
  ...Object.values(KB_EXTRACT_ERRORS),
  'Failed to save the knowledge item',
  ...Object.values(AGENT_ERRORS).filter((m) => m !== AGENT_ERRORS.body),
  ...Object.values(MEMORY_ERRORS).filter((m) => m !== MEMORY_ERRORS.body),
  'Contact memory',
  // /ai/agents copy held in constants (not t('literal') calls)
  ...Object.values(STATUS_LABEL),
  ...Object.values(MODE_LABEL),
  ...Object.values(CHANNEL_LABEL),
  ...AGENT_PRESETS.flatMap((p) => [p.label, p.summary]),
  ...SAFETY_CHECKS.flatMap((c) => [c.title, c.protects]),
  ...[
    { enabled: false, mode: 'suggest', paused_at: null },
    { enabled: true, mode: 'suggest', paused_at: null },
    { enabled: true, mode: 'auto', paused_at: 'x' },
    { enabled: true, mode: 'auto', paused_at: null },
  ].map((a) => operationHelp(a as Parameters<typeof operationHelp>[0])),
  ...['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
  'Tokens',
  'Cost',
  'Latency',
  'Model',
  'Could not load the AI agents',
  'Something went wrong. Try again.',
  'Could not save the agent',
  "Read-only — your role can't create AI agents",
];

describe('pt-BR dictionary — AI', () => {
  it.each(KEYS)('translates %s', (key) => {
    expect(translateLiteral(key, 'pt-BR')).not.toBe(key);
  });

  it('has no empty translations', () => {
    for (const [k, v] of Object.entries(DICT_AI)) expect(v.trim(), k).not.toBe('');
  });
});

// Every literal passed to t() in the AI screens — plus, in the /ai/agents
// components, the copy handed to t() through title / label / hint /
// description props.
const T_CALL = new RegExp(String.raw`\bt\(\s*(["'])(.*?)\1\s*,?\s*\)`, 'gs');
const COPY_PROP = /\b(?:title|label|hint|description)="([^"{}]+)"/g;
const PANEL_KEYS = (() => {
  const keys = new Set<string>();
  for (const file of [
    'components/settings/ai-settings.tsx',
    'components/settings/ai-knowledge.tsx',
    'components/ai-agents/agent-card.tsx',
    'components/ai-agents/agents-list.tsx',
    'components/ai-agents/new-agent-dialog.tsx',
    'components/ai-agents/agent-config-form.tsx',
    'components/ai-agents/agent-operation-bar.tsx',
    'components/ai-agents/agent-test-panel.tsx',
    'components/inbox/contact-memory.tsx',
    'app/(dashboard)/ai/agents/page.tsx',
    'app/(dashboard)/ai/agents/[id]/page.tsx',
  ]) {
    const src = readFileSync(join(process.cwd(), 'src', file), 'utf8');
    for (const m of src.matchAll(T_CALL)) keys.add(m[2]);
    if (file.includes('ai-agents/')) for (const m of src.matchAll(COPY_PROP)) keys.add(m[1]);
  }
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

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { translateLiteral } from '@/lib/i18n';

import { BOT_ISSUE_KEYS } from '@/components/settings/site-bot-editor';

import { DICT_SITE_BOT } from './site-bot';

const COMPONENTS = ['site-bot-editor', 'site-bot-preview', 'site-bots-group'].map((f) =>
  readFileSync(join(process.cwd(), 'src', 'components', 'settings', `${f}.tsx`), 'utf8'),
);

/** Every literal passed to t('...') by the bot editor, list and preview. */
function usedKeys(): string[] {
  const keys = new Set<string>();
  for (const src of COMPONENTS) {
    for (const m of src.matchAll(/\bt\((['"])((?:\\.|(?!\1).)*)\1\)/g)) {
      keys.add(m[2].replace(/\\'/g, "'").replace(/\\"/g, '"'));
    }
  }
  return [...keys];
}

const words = (s: string) => s.trim().split(/\s+/).length;

describe('site bot dictionary', () => {
  it('translates every string the bot editor renders', () => {
    const keys = usedKeys();
    expect(keys.length).toBeGreaterThan(50);
    for (const key of keys) {
      expect(translateLiteral(key, 'pt-BR'), key).not.toBe(key);
    }
  });

  it('uses multi-word keys and multi-word values, so the pt -> en pass cannot leak', () => {
    for (const [en, pt] of Object.entries(DICT_SITE_BOT)) {
      expect(words(en), en).toBeGreaterThan(1);
      expect(words(pt), pt).toBeGreaterThan(1);
      expect(pt, en).not.toBe(en);
    }
  });

  it('translates every message the checker can send, and every dictionary entry is used', () => {
    for (const key of BOT_ISSUE_KEYS) expect(translateLiteral(key, 'pt-BR'), key).not.toBe(key);
    const used = new Set([...usedKeys(), ...BOT_ISSUE_KEYS]);
    // Strings the editor composes from parts (see describeIssue) are used by name too.
    for (const key of Object.keys(DICT_SITE_BOT)) expect(used.has(key), key).toBe(true);
  });

  it('keeps what the admin typed out of the translator', () => {
    expect(COMPONENTS[0]).toContain('data-no-translate');
    expect(COMPONENTS[1]).toContain('data-no-translate');
    expect(COMPONENTS[2]).toContain('data-no-translate');
  });
});

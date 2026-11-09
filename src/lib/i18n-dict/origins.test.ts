import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { translateLiteral } from '@/lib/i18n';

import { DICT_ORIGINS } from './origins';

const FILES = [
  'src/components/origins/origin-line.tsx',
  'src/components/pipelines/deal-origin.tsx',
  'src/components/reports/origin-section.tsx',
  'src/app/(dashboard)/contacts/page.tsx',
].map((f) => readFileSync(join(process.cwd(), ...f.split('/')), 'utf8'));

/** Every literal passed to t('...') or t("...") by the origin screens. */
function usedKeys(): string[] {
  const keys = new Set<string>();
  for (const src of FILES) {
    for (const m of src.matchAll(/\bt\((['"])((?:\.|(?!\1).)*)\1\)/g)) keys.add(m[2]);
  }
  return [...keys];
}

const words = (s: string) => s.trim().split(/\s+/).length;

describe('origins dictionary', () => {
  it('translates every string the origin screens render', () => {
    for (const key of usedKeys()) expect(translateLiteral(key, 'pt-BR'), key).not.toBe(key);
  });

  it('uses multi-word keys and multi-word values, so the pt -> en pass cannot leak', () => {
    for (const [en, pt] of Object.entries(DICT_ORIGINS)) {
      expect(words(en), en).toBeGreaterThan(1);
      expect(words(pt), pt).toBeGreaterThan(1);
    }
  });

  it('every dictionary entry is used by a screen', () => {
    const used = new Set(usedKeys());
    for (const key of Object.keys(DICT_ORIGINS)) expect(used.has(key), key).toBe(true);
  });

  it('keeps the customer text (ad titles, campaigns, hosts) out of the translator', () => {
    expect(FILES[0]).toContain('data-no-translate');
    expect(FILES[2]).toContain('data-no-translate');
  });
});

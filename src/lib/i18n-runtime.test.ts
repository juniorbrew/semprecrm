import { describe, expect, it, vi } from 'vitest';
import { onDictChange, registerDict, translateLiteral } from './i18n-runtime';

describe('i18n runtime registry', () => {
  it('translates only what a chunk registered, both directions', () => {
    expect(translateLiteral('Zz probe one', 'pt-BR')).toBe('Zz probe one');
    registerDict({ 'Zz probe one': 'Sonda um' });
    expect(translateLiteral('Zz probe one', 'pt-BR')).toBe('Sonda um');
    // en-US maps registered Portuguese back; the reverse map is rebuilt
    expect(translateLiteral('Sonda um', 'en-US')).toBe('Zz probe one');
    registerDict({ 'Zz probe two': 'Sonda dois' });
    expect(translateLiteral('Sonda dois', 'en-US')).toBe('Zz probe two');
  });

  it('notifies listeners when a late chunk lands', () => {
    const fn = vi.fn();
    const off = onDictChange(fn);
    registerDict({ 'Zz probe three': 'Sonda três' });
    expect(fn).toHaveBeenCalledTimes(1);
    off();
    registerDict({ 'Zz probe four': 'Sonda quatro' });
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

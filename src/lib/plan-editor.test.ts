import { describe, expect, it } from 'vitest';
import { parseBrazilianPrice, parseCapacity } from './plan-editor';
describe('plan editor inputs', () => {
  it('converts decimal currency to exact cents', () => {
    expect(parseBrazilianPrice('59,90')).toBe(5990);
    expect(parseBrazilianPrice('0,01')).toBe(1);
    expect(parseBrazilianPrice('89.9')).toBe(8990);
  });
  it.each(['', '1,999', '1e2', '-1', '1.000,90', '90071992547409,92'])(
    'rejects invalid money %s',
    (value) => expect(parseBrazilianPrice(value)).toBeNull()
  );
  it('accepts zero and rejects fractional, blank or unsafe capacities', () => {
    expect(parseCapacity('0')).toBe(0);
    for (const value of ['', '1.5', '-1', '1e2', '9007199254740992'])
      expect(parseCapacity(value)).toBeNull();
  });
});

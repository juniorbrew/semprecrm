import { describe, expect, it } from 'vitest';
import { buildAudience, type AudienceBreakdown, type AudienceContact } from './audience';

const c = (id: string, phone: string | null = `+55 11 9${id.padStart(4, '0')}-0000`, over: Partial<AudienceContact> = {}): AudienceContact => ({
  id,
  phone,
  opted_out_at: null,
  anonymized_at: null,
  ...over,
});

const zero: AudienceBreakdown = {
  selected: 0,
  excludedByTag: 0,
  optedOut: 0,
  noPhone: 0,
  duplicate: 0,
  suppressed: 0,
  eligible: 0,
};

describe('buildAudience', () => {
  const cases: {
    name: string;
    candidates: AudienceContact[];
    excludedIds?: string[];
    suppressed?: string[];
    recipients: string[];
    breakdown: Partial<AudienceBreakdown>;
  }[] = [
    {
      name: 'everyone eligible',
      candidates: [c('1'), c('2')],
      recipients: ['1', '2'],
      breakdown: { selected: 2, eligible: 2 },
    },
    {
      name: 'opted out',
      candidates: [c('1'), c('2', undefined, { opted_out_at: '2026-01-01' })],
      recipients: ['1'],
      breakdown: { selected: 2, optedOut: 1, eligible: 1 },
    },
    {
      name: 'anonymised',
      candidates: [c('1'), c('2', 'anon-deadbeef', { anonymized_at: '2026-01-01' })],
      recipients: ['1'],
      breakdown: { selected: 2, optedOut: 1, eligible: 1 },
    },
    {
      name: 'excluded tag wins over opt-out (counted once)',
      candidates: [c('1'), c('2', undefined, { opted_out_at: '2026-01-01' }), c('3')],
      excludedIds: ['2', '3'],
      recipients: ['1'],
      breakdown: { selected: 3, excludedByTag: 2, eligible: 1 },
    },
    {
      name: 'no or invalid phone still gets a row (the sender fails it) but is not reached',
      candidates: [c('1'), c('2', null), c('3', 'abc'), c('4', '0123')],
      recipients: ['1', '2', '3', '4'],
      breakdown: { selected: 4, noPhone: 3, eligible: 1 },
    },
    {
      name: 'duplicates by normalized phone and by id',
      candidates: [c('1', '+55 11 99999-0000'), c('2', '5511999990000'), c('1', '+55 11 99999-0000'), c('3', null), c('4', null)],
      recipients: ['1', '3', '4'],
      breakdown: { selected: 5, duplicate: 2, noPhone: 2, eligible: 1 },
    },
    {
      name: 'suppressed number',
      candidates: [c('1', '+55 11 99999-0000'), c('2', '+55 11 98888-0000')],
      suppressed: ['5511988880000'],
      recipients: ['1', '2'],
      breakdown: { selected: 2, suppressed: 1, eligible: 1 },
    },
    {
      name: 'empty audience',
      candidates: [],
      recipients: [],
      breakdown: {},
    },
  ];

  it.each(cases)('$name', ({ candidates, excludedIds, suppressed, recipients, breakdown }) => {
    const result = buildAudience(candidates, {
      excludedIds: new Set(excludedIds),
      suppressed: new Set(suppressed),
    });
    expect(result.recipients.map((r) => r.id)).toEqual(recipients);
    expect(result.breakdown).toEqual({ ...zero, ...breakdown });
  });

  it('every selected contact lands in exactly one bucket', () => {
    const { breakdown: b } = buildAudience(
      [c('1'), c('2', null), c('3', undefined, { opted_out_at: 'x' }), c('4'), c('1')],
      { excludedIds: new Set(['4']) },
    );
    expect(b.excludedByTag + b.optedOut + b.noPhone + b.duplicate + b.suppressed + b.eligible).toBe(b.selected);
  });
});

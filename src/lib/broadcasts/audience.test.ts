import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  IN_LIST_PAGE,
  MAX_ROWS,
  buildAudience,
  estimateAudience,
  fetchAudienceContacts,
  fetchExcludedIds,
  type AudienceBreakdown,
  type AudienceContact,
} from './audience';
import { makeAudienceDb } from './fake-db.test-helper';

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

// ── Loaders against an in-memory PostgREST (max_rows = 1000) ──────

const id = (n: number) => `c${String(n).padStart(5, '0')}`;
const phone = (n: number) => `+55 11 9${String(n).padStart(4, '0')}-0000`;
const contactRow = (n: number, over: Record<string, unknown> = {}) => ({
  id: id(n),
  account_id: 'acc-1',
  phone: phone(n),
  phone_normalized: phone(n).replace(/\D/g, ''),
  opted_out_at: null,
  anonymized_at: null,
  ...over,
});
const range = (n: number) => Array.from({ length: n }, (_, i) => i + 1);

describe('fetchExcludedIds', () => {
  it('pages past max_rows: every contact of a 2 500-contact exclusion tag is excluded', async () => {
    const { db, log } = makeAudienceDb({
      contact_tags: range(2500).map((n) => ({ contact_id: id(n), tag_id: 'vip' })),
    });
    const excluded = await fetchExcludedIds(db, ['vip']);
    expect(excluded.size).toBe(2500);
    expect(log.ranges).toEqual(['contact_tags:0-999', 'contact_tags:1000-1999', 'contact_tags:2000-2999']);
  });

  it('throws when the exclusion lookup fails (fail closed)', async () => {
    const { db } = makeAudienceDb({}, ['contact_tags']);
    await expect(fetchExcludedIds(db, ['vip'])).rejects.toThrow(/excluded tags/);
  });
});

describe('fetchAudienceContacts', () => {
  it('keeps the max_rows cap, takes the first rows in a stable order, flags it, and keeps IN-lists small', async () => {
    const { db, log } = makeAudienceDb({
      contacts: range(1500).map((n) => contactRow(n)),
      contact_tags: range(1500).reverse().map((n) => ({ contact_id: id(n), tag_id: 't' })),
    });
    const { contacts, capped } = await fetchAudienceContacts<AudienceContact>(db, { type: 'tags', tagIds: ['t'] }, '*');
    expect(capped).toBe(true);
    expect(contacts).toHaveLength(MAX_ROWS);
    expect(contacts[0].id).toBe(id(1));
    expect(contacts.at(-1)!.id).toBe(id(MAX_ROWS));
    expect(Math.max(...log.inSizes)).toBeLessThanOrEqual(IN_LIST_PAGE);
  });

  it('"all" is capped and flagged the same way; small audiences are not flagged', async () => {
    const big = makeAudienceDb({ contacts: range(1200).map((n) => contactRow(n)) });
    expect((await fetchAudienceContacts(big.db, { type: 'all' }, '*')).capped).toBe(true);
    const small = makeAudienceDb({ contacts: range(3).map((n) => contactRow(n)) });
    expect(await fetchAudienceContacts(small.db, { type: 'all' }, '*')).toMatchObject({ capped: false });
  });
});

describe('estimateAudience', () => {
  const suppressionResponse = (body: unknown, status = 200) =>
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(body), { status }));

  afterEach(() => vi.restoreAllMocks());

  it('maps CSV rows onto existing contacts, writes nothing and drops suppressed numbers', async () => {
    const { db, log } = makeAudienceDb({
      contacts: [contactRow(1, { opted_out_at: '2026-01-01' }), contactRow(2), contactRow(3)],
      contact_tags: [{ contact_id: id(2), tag_id: 'skip' }],
    });
    const fetchSpy = suppressionResponse({ suppressed: [phone(5).replace(/\D/g, '')] });
    const estimate = await estimateAudience(
      db,
      {
        type: 'csv',
        excludeTagIds: ['skip'],
        csvContacts: [
          { phone: phone(1) }, // existing, opted out
          { phone: phone(2) }, // existing, excluded tag
          { phone: phone(3) }, // existing, reachable
          { phone: phone(4) }, // new number
          { phone: phone(4).replace(/\D/g, '') }, // same number again
          { phone: phone(5) }, // new number, on the suppression list
        ],
      },
      'acc-1',
    );
    expect(estimate).toEqual({
      breakdown: { selected: 6, duplicate: 1, excludedByTag: 1, optedOut: 1, noPhone: 0, suppressed: 1, eligible: 2 },
      suppressionChecked: true,
      capped: false,
    });
    expect(log.writes).toEqual([]);
    expect(fetchSpy).toHaveBeenCalledWith('/api/contacts/suppressions/check', expect.objectContaining({ method: 'POST' }));
  });

  it('when the suppression check fails the number is an upper bound ("até N")', async () => {
    const { db } = makeAudienceDb({ contacts: range(3).map((n) => contactRow(n)) });
    suppressionResponse({ error: 'x' }, 500);
    expect(await estimateAudience(db, { type: 'all' }, 'acc-1')).toEqual({
      breakdown: { selected: 3, duplicate: 0, excludedByTag: 0, optedOut: 0, noPhone: 0, suppressed: 0, eligible: 3 },
      suppressionChecked: false,
      capped: false,
    });
  });

  it('rejects (no estimate) when a lookup fails, and is null while the audience is incomplete', async () => {
    const { db } = makeAudienceDb({ contacts: [contactRow(1)] }, ['contact_tags']);
    await expect(estimateAudience(db, { type: 'all', excludeTagIds: ['x'] }, 'acc-1')).rejects.toThrow();
    expect(await estimateAudience(db, { type: 'tags', tagIds: [] }, 'acc-1')).toBeNull();
  });
});

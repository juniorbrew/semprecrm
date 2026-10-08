import { describe, expect, it } from 'vitest';
import type { PlatformAccountRow } from '@/types';
import { PLAN_CATALOG } from '@/lib/plans';
import {
  DEFAULT_COMPANY_FILTERS as defaults,
  matchesCompanyFilters,
  parseCompanyFilters,
} from './account-filters';
const now = new Date('2026-10-07T12:00:00Z');
const row = (
  overrides: Partial<PlatformAccountRow> = {}
): PlatformAccountRow => ({
  id: 'id',
  owner_user_id: 'owner',
  name: 'Empresa São José',
  owner_name: 'Cláudia',
  owner_email: 'person@example.test',
  plan: 'pro',
  plan_version_id: '39000000-0000-4000-8000-000000000001',
  plan_definition: PLAN_CATALOG[overrides.plan ?? 'pro'],
  plan_status: 'active',
  plan_expires_at: null,
  module_overrides: {},
  limit_overrides: {},
  platform_notes: null,
  members_count: 1,
  channels_count: 0,
  pending_invites_count: 0,
  created_at: now.toISOString(),
  updated_at: now.toISOString(),
  ...overrides,
});
describe('company list filters', () => {
  it('combines plan, status, capacity, expiry and accent-insensitive search', () => {
    const filters = {
      ...defaults,
      plan: 'pro' as const,
      status: 'active' as const,
      attention: 'limits' as const,
      expiry: '30days' as const,
      query: 'sao jose',
    };
    const company = row({
      plan_expires_at: '2026-10-20T12:00:00Z',
      members_count: 2,
      limit_overrides: { max_users: 2 },
    });
    expect(matchesCompanyFilters(company, filters, now)).toBe(true);
    expect(
      matchesCompanyFilters(company, { ...filters, plan: 'basico' }, now)
    ).toBe(false);
    expect(
      matchesCompanyFilters(company, { ...filters, status: 'suspended' }, now)
    ).toBe(false);
    expect(
      matchesCompanyFilters(
        company,
        { ...filters, query: 'another company' },
        now
      )
    ).toBe(false);
    expect(
      matchesCompanyFilters(company, { ...filters, expiry: '7days' }, now)
    ).toBe(false);
  });
  it('searches the responsible person and email after trimming', () => {
    expect(
      matchesCompanyFilters(row(), { ...defaults, query: '  claudia ' }, now)
    ).toBe(true);
    expect(
      matchesCompanyFilters(
        row(),
        { ...defaults, query: 'PERSON@EXAMPLE.TEST' },
        now
      )
    ).toBe(true);
    expect(
      matchesCompanyFilters(
        row({ owner_name: null, owner_email: null }),
        { ...defaults, query: 'person' },
        now
      )
    ).toBe(false);
  });
  it.each([
    ['7days', '2026-10-14T12:00:00Z'],
    ['30days', '2026-11-06T12:00:00Z'],
  ] as const)(
    'includes the exact %s cutoff and excludes later or expired dates',
    (expiry, end) => {
      expect(
        matchesCompanyFilters(
          row({ plan_expires_at: end }),
          { ...defaults, expiry },
          now
        )
      ).toBe(true);
      expect(
        matchesCompanyFilters(
          row({ plan_expires_at: new Date(Date.parse(end) + 1).toISOString() }),
          { ...defaults, expiry },
          now
        )
      ).toBe(false);
      expect(
        matchesCompanyFilters(
          row({ plan_expires_at: now.toISOString() }),
          { ...defaults, expiry },
          now
        )
      ).toBe(false);
      expect(
        matchesCompanyFilters(
          row({ plan_expires_at: end, plan_status: 'canceled' }),
          { ...defaults, expiry },
          now
        )
      ).toBe(false);
    }
  );
  it('separates expired, invalid and absent expirations', () => {
    expect(
      matchesCompanyFilters(
        row({ plan_expires_at: now.toISOString() }),
        { ...defaults, expiry: 'expired' },
        now
      )
    ).toBe(true);
    expect(
      matchesCompanyFilters(row(), { ...defaults, expiry: 'none' }, now)
    ).toBe(true);
    expect(
      matchesCompanyFilters(
        row({ plan_expires_at: 'invalid' }),
        { ...defaults, expiry: 'none' },
        now
      )
    ).toBe(false);
    expect(
      matchesCompanyFilters(
        row({ plan_expires_at: 'invalid' }),
        { ...defaults, expiry: 'expired' },
        now
      )
    ).toBe(false);
  });
  it('preserves overview expiration links and explicit expiry precedence', () => {
    expect(parseCompanyFilters({ attention: 'expired' })).toEqual({
      ...defaults,
      expiry: 'expired',
    });
    expect(parseCompanyFilters({ attention: 'expiring' })).toEqual({
      ...defaults,
      expiry: '7days',
    });
    expect(
      parseCompanyFilters({ attention: 'expired', expiry: 'none' })
    ).toEqual({ ...defaults, expiry: 'none' });
  });
  it('parses valid filters and ignores malformed URL values', () => {
    expect(
      parseCompanyFilters({
        plan: 'basico',
        status: 'suspended',
        expiry: '30days',
        attention: 'limits',
        q: 'Cláudia',
      })
    ).toEqual({
      plan: 'basico',
      status: 'suspended',
      expiry: '30days',
      attention: 'limits',
      query: 'Cláudia',
    });
    expect(
      parseCompanyFilters({
        plan: ['pro', 'basico'],
        status: 'invalid',
        expiry: 'invalid',
        attention: 'invalid',
        q: ['name'],
      })
    ).toEqual(defaults);
  });
});

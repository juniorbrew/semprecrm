import { describe, expect, it } from 'vitest';
import {
  parseHistoryFilters,
  projectHistoryChanges,
  projectPlanVersionChange,
} from './history';

describe('version change projection', () => {
  it('exposes only positive safe revision numbers', () => {
    expect(
      projectPlanVersionChange('plan.changed', {
        plan_version_change: {
          from_revision: 1,
          to_revision: 2,
          secret: 'hidden',
        },
      })
    ).toEqual({ from_revision: 1, to_revision: 2 });
    for (const value of [-1, 0, 1.5, '2', Number.MAX_SAFE_INTEGER + 1])
      expect(
        projectPlanVersionChange('plan.changed', {
          plan_version_change: { from_revision: 1, to_revision: value },
        })
      ).toBeNull();
    expect(
      projectPlanVersionChange('contact.deleted', {
        plan_version_change: { from_revision: 1, to_revision: 2 },
      })
    ).toBeNull();
  });
});

describe('history date and actor filters', () => {
  it('includes whole Bahia days using an exclusive next-day boundary', () => {
    expect(
      parseHistoryFilters(
        new URLSearchParams(
          'startDate=2026-10-01&endDate=2026-10-07&action=plan.changed&actor=Maria'
        )
      )
    ).toEqual({
      start: '2026-10-01T03:00:00.000Z',
      end: '2026-10-08T03:00:00.000Z',
      action: 'plan.changed',
      actor: '%Maria%',
    });
  });
  it('escapes SQL pattern characters in literal actor search', () => {
    expect(
      parseHistoryFilters(new URLSearchParams({ actor: '  A_%\\  ' })).actor
    ).toBe('%A\\_\\%\\\\%');
  });
  it.each([
    'startDate=2026-02-30',
    'endDate=garbage',
    'startDate=2026-10-08&endDate=2026-10-07',
    'action=unknown',
    'actor=' + 'x'.repeat(121),
    'startDate=0000-01-01',
  ])('rejects invalid input %s', (query) => {
    expect(() => parseHistoryFilters(new URLSearchParams(query))).toThrow();
  });
  it('supports open dates, leap days and year rollover', () => {
    expect(
      parseHistoryFilters(new URLSearchParams('startDate=2024-02-29')).start
    ).toBe('2024-02-29T03:00:00.000Z');
    expect(
      parseHistoryFilters(new URLSearchParams('endDate=2026-12-31')).end
    ).toBe('2027-01-01T03:00:00.000Z');
  });
});
describe('safe administrative history details', () => {
  it('projects only known keys and valid values, never arbitrary metadata', () => {
    const result = projectHistoryChanges('plan.changed', {
      secret: 'SECRET',
      changes: {
        plan: { from: 'trial', to: 'pro' },
        module_overrides: {
          from: { tasks: false, token: 'SECRET' },
          to: { tasks: true, ai: null },
        },
        limit_overrides: {
          from: {},
          to: { max_users: null, max_channels: 2, password: 'SECRET' },
        },
        password: { from: 'SECRET', to: 'SECRET' },
        plan_status: { from: 'SECRET', to: 'SECRET' },
      },
    });
    expect(result).toEqual([
      { field: 'plan', from: 'trial', to: 'pro' },
      {
        field: 'module_overrides',
        from: { tasks: false },
        to: { tasks: true },
      },
      {
        field: 'limit_overrides',
        from: {},
        to: { max_users: null, max_channels: 2 },
      },
    ]);
    expect(JSON.stringify(result)).not.toContain('SECRET');
  });
  it('ignores malformed, unchanged, and unrelated action metadata', () => {
    expect(
      projectHistoryChanges('contact.deleted', {
        changes: { plan: { from: 'trial', to: 'pro' } },
      })
    ).toEqual([]);
    expect(
      projectHistoryChanges('plan.changed', {
        changes: {
          plan: { from: 'pro', to: 'pro' },
          plan_expires_at: { from: null, to: 'SECRET' },
          module_overrides: { from: [], to: 'SECRET' },
        },
      })
    ).toEqual([]);
    for (const value of [null, [], 'SECRET', { changes: null }])
      expect(projectHistoryChanges('plan.changed', value)).toEqual([]);
  });
  it('retains null expiry and removes invalid limit values', () => {
    expect(
      projectHistoryChanges('plan.changed', {
        changes: {
          plan_expires_at: { from: '2026-10-07T00:00:00Z', to: null },
          limit_overrides: {
            from: { max_users: -1 },
            to: { max_users: 4, max_channels: 1.5 },
          },
        },
      })
    ).toEqual([
      { field: 'plan_expires_at', from: '2026-10-07T00:00:00Z', to: null },
      { field: 'limit_overrides', from: {}, to: { max_users: 4 } },
    ]);
  });
});

import { describe, expect, it } from 'vitest';
import type { PlatformAccountRow } from '@/types';
import { PLAN_CATALOG } from '@/lib/plans';
import {
  getAccountHealth,
  summarizeAccounts,
  matchesAccountFilter,
} from './overview';

const now = new Date('2026-10-06T12:00:00Z');
function account(
  overrides: Partial<PlatformAccountRow> = {}
): PlatformAccountRow {
  return {
    id: 'company',
    owner_user_id: 'owner',
    name: 'Empresa',
    plan: 'pro',
    plan_version_id: '39000000-0000-4000-8000-000000000001',
    plan_definition: PLAN_CATALOG[overrides.plan ?? 'pro'],
    plan_status: 'active',
    plan_expires_at: null,
    module_overrides: {},
    limit_overrides: {},
    platform_notes: null,
    owner_name: null,
    owner_email: null,
    members_count: 1,
    channels_count: 0,
    pending_invites_count: 0,
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
    ...overrides,
  };
}

describe('platform overview', () => {
  it.each([
    { official_disconnected: true },
    { qr_disconnected: true },
    { official_disconnected: true, qr_disconnected: true },
  ])('includes recorded channel alerts once per company: %j', (channels) => {
    const row = { ...account(), ...channels };
    expect(getAccountHealth(row, now).attention).toBe(true);
    expect(summarizeAccounts([row], now).attention).toBe(1);
    expect(
      summarizeAccounts([{ ...row, plan_status: 'suspended' }], now).attention
    ).toBe(1);
  });
  it.each(['suspended', 'past_due'] as const)(
    'includes %s companies even without expiration or capacity alerts',
    (plan_status) => {
      const row = account({ plan_status });
      expect(getAccountHealth(row, now).attention).toBe(true);
      expect(summarizeAccounts([row], now)).toMatchObject({
        attention: 1,
        expiring: 0,
        expired: 0,
        atLimit: 0,
      });
      expect(
        summarizeAccounts([{ ...row, members_count: 10 }], now).attention
      ).toBe(1);
    }
  );
  it('does not flag a healthy or canceled company without other alerts', () => {
    expect(getAccountHealth(account(), now).attention).toBe(false);
    expect(
      getAccountHealth(account({ plan_status: 'canceled' }), now).attention
    ).toBe(false);
  });
  it('counts operational trials separately from expired trials and suspended companies', () => {
    const rows = [
      account(),
      account({ plan_status: 'trial' }),
      account({ plan_status: 'trial', plan_expires_at: now.toISOString() }),
      account({ plan_status: 'suspended' }),
    ];
    expect(summarizeAccounts(rows, now)).toMatchObject({
      total: 4,
      active: 1,
      trial: 1,
      suspended: 1,
      expired: 1,
    });
    expect(matchesAccountFilter(rows[2], 'trial', 'all', now)).toBe(false);
  });
  it('includes the seven-day boundary but separates expired and invalid dates', () => {
    expect(
      getAccountHealth(
        account({ plan_expires_at: '2026-10-13T12:00:00Z' }),
        now
      ).expiring
    ).toBe(true);
    expect(
      getAccountHealth(
        account({ plan_expires_at: '2026-10-13T12:00:01Z' }),
        now
      ).expiring
    ).toBe(false);
    expect(
      getAccountHealth(account({ plan_expires_at: now.toISOString() }), now)
        .expired
    ).toBe(true);
    expect(
      getAccountHealth(account({ plan_expires_at: 'invalid' }), now).expired
    ).toBe(false);
    expect(
      getAccountHealth(
        account({
          plan_status: 'canceled',
          plan_expires_at: '2026-10-07T12:00:00Z',
        }),
        now
      ).expiring
    ).toBe(false);
  });
  it('uses overrides and pending invites for limits, ignoring unlimited capacity', () => {
    const row = account({
      members_count: 2,
      pending_invites_count: 1,
      channels_count: 2,
      limit_overrides: { max_users: 3, max_channels: null },
    });
    expect(getAccountHealth(row, now)).toMatchObject({
      usersAtLimit: true,
      channelsAtLimit: false,
    });
    expect(matchesAccountFilter(row, 'all', 'limits', now)).toBe(true);
    expect(
      getAccountHealth(account({ limit_overrides: { max_channels: 0 } }), now)
        .channelsAtLimit
    ).toBe(false);
    expect(
      getAccountHealth(
        account({ channels_count: 1, limit_overrides: { max_channels: 0 } }),
        now
      ).channelsAtLimit
    ).toBe(true);
  });
  it('counts companies needing attention once even with multiple alerts', () => {
    const row = account({
      members_count: 10,
      channels_count: 2,
      plan_expires_at: '2026-10-07T12:00:00Z',
    });
    expect(summarizeAccounts([row], now)).toMatchObject({
      attention: 1,
      expiring: 1,
      atLimit: 1,
    });
    expect(matchesAccountFilter(row, 'suspended', 'expiring', now)).toBe(false);
    expect(summarizeAccounts([], now).total).toBe(0);
  });
});

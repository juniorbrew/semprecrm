import { describe, expect, it } from 'vitest';

import type { SupabaseClient } from '@supabase/supabase-js';

import { PLAN_CATALOG } from './plans';
import { accountHasModule, accountIsWritable } from './plans-server';

const VERSION = '39000000-0000-4000-8000-000000000001';

/** A client whose accounts read returns this plan row. */
function dbWith(row: Record<string, unknown> | null): SupabaseClient {
  const q = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: row, error: null }) };
  return { from: () => q } as unknown as SupabaseClient;
}
const account = (plan_status: string, plan_expires_at: string | null = null) => ({
  plan: 'pro',
  plan_status,
  plan_expires_at,
  plan_version_id: VERSION,
  plan_version: { id: VERSION, plan: 'pro', definition: PLAN_CATALOG.pro },
  module_overrides: {},
  limit_overrides: {},
});

describe('accountIsWritable / accountHasModule in read-only mode', () => {
  it('active accounts are writable and have their modules', async () => {
    expect(await accountIsWritable(dbWith(account('active')), 'a')).toBe(true);
    expect(await accountHasModule(dbWith(account('active')), 'a', 'automations')).toBe(true);
  });

  it.each(['past_due', 'suspended', 'canceled'])('%s is not writable and has no modules', async (status) => {
    expect(await accountIsWritable(dbWith(account(status)), 'a')).toBe(false);
    expect(await accountHasModule(dbWith(account(status)), 'a', 'automations')).toBe(false);
  });

  it('an expired trial is not writable', async () => {
    expect(await accountIsWritable(dbWith(account('trial', '2020-01-01T00:00:00Z')), 'a')).toBe(false);
  });

  it('a platform "valid until" in the past on an ACTIVE account does not block', async () => {
    expect(await accountIsWritable(dbWith(account('active', '2020-01-01T00:00:00Z')), 'a')).toBe(true);
  });

  it('an unreadable account fails closed', async () => {
    expect(await accountIsWritable(dbWith(null), 'a')).toBe(false);
  });

  it('allowReadOnly lets inbound capture through for read-only accounts only', async () => {
    const opts = { allowReadOnly: true };
    expect(await accountHasModule(dbWith(account('past_due')), 'a', 'lead_capture', opts)).toBe(true);
    expect(await accountHasModule(dbWith(account('trial', '2020-01-01T00:00:00Z')), 'a', 'lead_capture', opts)).toBe(true);
    expect(await accountHasModule(dbWith(account('suspended')), 'a', 'lead_capture', opts)).toBe(false);
    expect(await accountHasModule(dbWith(account('canceled')), 'a', 'lead_capture', opts)).toBe(false);
    expect(await accountHasModule(dbWith(null), 'a', 'lead_capture', opts)).toBe(false);
  });
});

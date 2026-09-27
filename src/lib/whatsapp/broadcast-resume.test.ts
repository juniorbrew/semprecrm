import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { BroadcastError } from './broadcast-core';
import {
  claimBroadcastDelivery,
  planBroadcastResume,
  releaseBroadcastDelivery,
  RESUME_MAX_PER_REQUEST,
} from './broadcast-resume';

vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: (v: string) => `decrypted:${v}`,
}));

// Ported from wacrm 3376991 (broadcast-resume.test.ts), adapted to the
// SempreCRM plan shape (header media, opt-out, exact template lookup).

// ============================================================
// Claim / release — the mutex that stops a double-send.
// ============================================================

interface ClaimCall {
  update: Record<string, unknown>;
  filters: Record<string, unknown>;
  or?: string;
}

function claimDb(returnedRows: unknown[], calls: ClaimCall[]): SupabaseClient {
  return {
    from() {
      const call: ClaimCall = { update: {}, filters: {} };
      const b: Record<string, unknown> = {
        update: (row: Record<string, unknown>) => {
          call.update = row;
          calls.push(call);
          return b;
        },
        eq: (col: string, val: unknown) => {
          call.filters[col] = val;
          return b;
        },
        or: (expr: string) => {
          call.or = expr;
          return b;
        },
        select: async () => ({ data: returnedRows, error: null }),
        then: (resolve: (r: { error: null }) => unknown) => resolve({ error: null }),
      };
      return b;
    },
  } as unknown as SupabaseClient;
}

describe('claimBroadcastDelivery', () => {
  it('claims when the conditional UPDATE matched a row', async () => {
    const calls: ClaimCall[] = [];
    const ok = await claimBroadcastDelivery(
      claimDb([{ id: 'bc-1' }], calls),
      'acct-1',
      'bc-1',
      new Date('2026-08-11T12:00:00Z'),
    );

    expect(ok).toBe(true);
    expect(calls[0].filters).toEqual({ id: 'bc-1', account_id: 'acct-1' });
    expect(calls[0].update.delivery_locked_at).toBe('2026-08-11T12:00:00.000Z');
  });

  it('refuses when another pass (or the wizard tab) holds the lock', async () => {
    const ok = await claimBroadcastDelivery(claimDb([], []), 'acct-1', 'bc-1');
    expect(ok).toBe(false);
  });

  it('treats a lock older than the staleness window as abandoned', async () => {
    const calls: ClaimCall[] = [];
    await claimBroadcastDelivery(
      claimDb([{ id: 'bc-1' }], calls),
      'acct-1',
      'bc-1',
      new Date('2026-08-11T12:00:00Z'),
    );
    // 10 minutes before "now" (SempreCRM renews the lock while sending).
    expect(calls[0].or).toBe(
      'delivery_locked_at.is.null,delivery_locked_at.lt.2026-08-11T11:50:00.000Z',
    );
  });

  it('is scoped to the account, so another tenant cannot claim it', async () => {
    const calls: ClaimCall[] = [];
    await claimBroadcastDelivery(claimDb([], calls), 'acct-9', 'bc-1');
    expect(calls[0].filters.account_id).toBe('acct-9');
  });
});

describe('releaseBroadcastDelivery', () => {
  it('clears the lock', async () => {
    const calls: ClaimCall[] = [];
    await releaseBroadcastDelivery(claimDb([], calls), 'bc-1');
    expect(calls[0].update).toEqual({ delivery_locked_at: null });
    expect(calls[0].filters).toEqual({ id: 'bc-1' });
  });
});

// ============================================================
// Planning — which recipients a pass picks up, and with what params.
// ============================================================

interface PlanFixture {
  broadcast?: Record<string, unknown> | null;
  recipients?: Record<string, unknown>[];
  config?: Record<string, unknown> | null;
  template?: Record<string, unknown> | null;
}

interface PlanWrites {
  statusFilter?: unknown;
  failedBatches: { ids: unknown; update: Record<string, unknown> }[];
  templateFilters: Record<string, unknown>;
}

function newWrites(): PlanWrites {
  return { failedBatches: [], templateFilters: {} };
}

function planDb(fx: PlanFixture, writes: PlanWrites = newWrites()): SupabaseClient {
  return {
    from(table: string) {
      let pendingUpdate: Record<string, unknown> | null = null;
      const b: Record<string, unknown> = {
        select: () => b,
        eq: (col: string, val: unknown) => {
          if (table === 'message_templates') writes.templateFilters[col] = val;
          return b;
        },
        order: () => b,
        in: (col: string, vals: unknown) => {
          if (col === 'status') writes.statusFilter = vals;
          if (col === 'id' && pendingUpdate) {
            writes.failedBatches.push({ ids: vals, update: pendingUpdate });
          }
          return b;
        },
        update: (row: Record<string, unknown>) => {
          pendingUpdate = row;
          return b;
        },
        maybeSingle: async () => {
          if (table === 'broadcasts') {
            return { data: fx.broadcast === undefined ? null : fx.broadcast, error: null };
          }
          if (table === 'message_templates') {
            return { data: fx.template ?? null, error: null };
          }
          return { data: null, error: null };
        },
        single: async () => ({
          data: fx.config === undefined ? null : fx.config,
          error: null,
        }),
        then: (resolve: (r: { data: unknown[]; error: null }) => unknown) => {
          if (table === 'broadcast_recipients' && !pendingUpdate) {
            return resolve({ data: fx.recipients ?? [], error: null });
          }
          return resolve({ data: [], error: null });
        },
      };
      return b;
    },
  } as unknown as SupabaseClient;
}

const BROADCAST = {
  id: 'bc-1',
  template_name: 'order_update',
  template_language: 'pt_BR',
  header_media_url: null,
};

const CONFIG = { phone_number_id: 'pn-1', access_token: 'tok' };

function recipient(
  id: string,
  phone: string | null,
  params: unknown = ['A123'],
  optedOutAt: string | null = null,
) {
  return {
    id,
    template_params: params,
    contact: phone || optedOutAt ? { phone, opted_out_at: optedOutAt } : null,
  };
}

describe('planBroadcastResume', () => {
  it('plans the outstanding recipients with their frozen params', async () => {
    const writes = newWrites();
    const { plan, remaining, unsendable } = await planBroadcastResume(
      planDb(
        {
          broadcast: BROADCAST,
          config: CONFIG,
          recipients: [
            recipient('r1', '+5511991234567', ['A123', 'sexta']),
            recipient('r2', '+5511998765432', ['B456', 'segunda']),
          ],
        },
        writes,
      ),
      'acct-1',
      'bc-1',
      'pending',
    );

    expect(writes.statusFilter).toEqual(['pending']);
    expect(plan.planned).toEqual([
      { recipientRowId: 'r1', phone: '5511991234567', params: ['A123', 'sexta'] },
      { recipientRowId: 'r2', phone: '5511998765432', params: ['B456', 'segunda'] },
    ]);
    expect(plan.accessToken).toBe('decrypted:tok');
    expect(plan.headerMediaUrl).toBeNull();
    expect(remaining).toBe(0);
    expect(unsendable).toBe(0);
  });

  it('carries the header media URL chosen in the wizard', async () => {
    const { plan } = await planBroadcastResume(
      planDb({
        broadcast: { ...BROADCAST, header_media_url: 'https://cdn.test/promo.jpg' },
        config: CONFIG,
        recipients: [recipient('r1', '+5511991234567')],
      }),
      'acct-1',
      'bc-1',
      'pending',
    );
    expect(plan.headerMediaUrl).toBe('https://cdn.test/promo.jpg');
  });

  it('scopes to failed rows when retrying, and to both for "all"', async () => {
    const failedWrites = newWrites();
    await planBroadcastResume(
      planDb(
        { broadcast: BROADCAST, config: CONFIG, recipients: [recipient('r1', '+5511991234567')] },
        failedWrites,
      ),
      'acct-1',
      'bc-1',
      'failed',
    );
    expect(failedWrites.statusFilter).toEqual(['failed']);

    const allWrites = newWrites();
    await planBroadcastResume(
      planDb(
        { broadcast: BROADCAST, config: CONFIG, recipients: [recipient('r1', '+5511991234567')] },
        allWrites,
      ),
      'acct-1',
      'bc-1',
      'all',
    );
    expect(allWrites.statusFilter).toEqual(['pending', 'failed']);
  });

  it('treats a missing or malformed params column as no params', async () => {
    const { plan } = await planBroadcastResume(
      planDb({
        broadcast: BROADCAST,
        config: CONFIG,
        recipients: [
          // Rows created before migration 051 carry NULL.
          recipient('r1', '+5511991234567', null),
          recipient('r2', '+5511998765432', 'not-an-array'),
        ],
      }),
      'acct-1',
      'bc-1',
      'pending',
    );
    expect(plan.planned.map((p) => p.params)).toEqual([[], []]);
  });

  it('fails unsendable rows up front so they stop blocking the status', async () => {
    const writes = newWrites();
    const { plan, unsendable } = await planBroadcastResume(
      planDb(
        {
          broadcast: BROADCAST,
          config: CONFIG,
          recipients: [
            recipient('r1', '+5511991234567'),
            recipient('r2', null),
            recipient('r3', 'nonsense'),
          ],
        },
        writes,
      ),
      'acct-1',
      'bc-1',
      'pending',
    );

    expect(unsendable).toBe(2);
    expect(writes.failedBatches).toEqual([
      {
        ids: ['r2', 'r3'],
        update: { status: 'failed', error_message: 'No valid phone number on contact' },
      },
    ]);
    expect(plan.planned).toHaveLength(1);
  });

  it('never sends to a contact who opted out (migration 030)', async () => {
    const writes = newWrites();
    const { plan, unsendable } = await planBroadcastResume(
      planDb(
        {
          broadcast: BROADCAST,
          config: CONFIG,
          recipients: [
            recipient('r1', '+5511991234567'),
            recipient('r2', '+5511998765432', ['x'], '2026-09-01T00:00:00Z'),
          ],
        },
        writes,
      ),
      'acct-1',
      'bc-1',
      'failed',
    );
    expect(plan.planned.map((p) => p.recipientRowId)).toEqual(['r1']);
    expect(unsendable).toBe(1);
    expect(writes.failedBatches).toEqual([
      { ids: ['r2'], update: { status: 'failed', error_message: 'Contact opted out' } },
    ]);
  });

  it('caps one pass and reports the leftover', async () => {
    const many = Array.from({ length: RESUME_MAX_PER_REQUEST + 25 }, (_, i) =>
      recipient(`r${i}`, '+551199' + String(i).padStart(7, '0')),
    );
    const { plan, remaining } = await planBroadcastResume(
      planDb({ broadcast: BROADCAST, config: CONFIG, recipients: many }),
      'acct-1',
      'bc-1',
      'pending',
    );
    expect(plan.planned).toHaveLength(RESUME_MAX_PER_REQUEST);
    expect(remaining).toBe(25);
  });

  it('404s a broadcast that is not on this account', async () => {
    await expect(
      planBroadcastResume(planDb({ broadcast: null }), 'acct-1', 'bc-1', 'pending'),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('refuses when there is nothing outstanding', async () => {
    await expect(
      planBroadcastResume(
        planDb({ broadcast: BROADCAST, config: CONFIG, recipients: [] }),
        'acct-1',
        'bc-1',
        'failed',
      ),
    ).rejects.toBeInstanceOf(BroadcastError);
  });

  it('refuses when WhatsApp is not configured', async () => {
    await expect(
      planBroadcastResume(
        planDb({
          broadcast: BROADCAST,
          config: null,
          recipients: [recipient('r1', '+5511991234567')],
        }),
        'acct-1',
        'bc-1',
        'pending',
      ),
    ).rejects.toMatchObject({ code: 'whatsapp_not_configured', status: 400 });
  });

  it('loads the template row like the broadcast route (account + name + language)', async () => {
    const writes = newWrites();
    const template = {
      id: 'tpl-1',
      user_id: 'u-1',
      name: 'order_update',
      language: 'pt_BR',
      body_text: 'Seu pedido {{1}} sai {{2}}',
    };
    const { plan } = await planBroadcastResume(
      planDb(
        {
          broadcast: BROADCAST,
          config: CONFIG,
          recipients: [recipient('r1', '+5511991234567')],
          template,
        },
        writes,
      ),
      'acct-1',
      'bc-1',
      'pending',
    );
    expect(writes.templateFilters).toEqual({
      account_id: 'acct-1',
      name: 'order_update',
      language: 'pt_BR',
    });
    expect(plan.templateRow).toEqual(template);
  });

  it('refuses a malformed local template row', async () => {
    await expect(
      planBroadcastResume(
        planDb({
          broadcast: BROADCAST,
          config: CONFIG,
          recipients: [recipient('r1', '+5511991234567')],
          template: { id: 'tpl-1', name: 'order_update' },
        }),
        'acct-1',
        'bc-1',
        'pending',
      ),
    ).rejects.toMatchObject({ code: 'template_malformed' });
  });
});

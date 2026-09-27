import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

const sendTemplateMessage = vi.fn();
vi.mock('@/lib/whatsapp/meta-api', () => ({
  sendTemplateMessage: (...args: unknown[]) => sendTemplateMessage(...args),
}));

import {
  deliverBroadcast,
  finalizeBroadcastStatus,
  DELIVERY_LOCK_HEARTBEAT_EVERY,
  type BroadcastPlan,
} from './broadcast-core';

// Ported from wacrm 3376991 (finalizeBroadcastStatus matrix) plus
// SempreCRM-specific delivery checks (header media, lock heartbeat).

// ============================================================
// Terminal status (#472). Derived from the recipient rows, not from a
// counter local to one delivery pass.
// ============================================================

function statusDb(
  counts: Record<string, number>,
  total: number,
  writes: { update?: Record<string, unknown> },
) {
  return {
    from(table: string) {
      let status: string | null = null;
      const b: Record<string, unknown> = {
        select: () => b,
        eq: (col: string, val: unknown) => {
          if (col === 'status') status = val as string;
          return b;
        },
        update: (row: Record<string, unknown>) => {
          if (table === 'broadcasts') writes.update = row;
          return b;
        },
        then: (resolve: (r: { count: number; error: null }) => unknown) =>
          resolve({
            count: status === null ? total : (counts[status] ?? 0),
            error: null,
          }),
      };
      return b;
    },
  } as unknown as SupabaseClient;
}

describe('finalizeBroadcastStatus', () => {
  it('leaves a capped pass in "sending" while recipients are still pending', async () => {
    const writes: { update?: Record<string, unknown> } = {};
    await finalizeBroadcastStatus(statusDb({ pending: 25 }, 1025, writes), 'b-1');
    expect(writes.update).toBeUndefined();
  });

  it('marks a fully-failed broadcast failed', async () => {
    const writes: { update?: Record<string, unknown> } = {};
    await finalizeBroadcastStatus(statusDb({ pending: 0, failed: 10 }, 10, writes), 'b-1');
    expect(writes.update?.status).toBe('failed');
  });

  it('marks a partially-failed broadcast sent', async () => {
    const writes: { update?: Record<string, unknown> } = {};
    await finalizeBroadcastStatus(statusDb({ pending: 0, failed: 3 }, 10, writes), 'b-1');
    expect(writes.update?.status).toBe('sent');
  });

  it('does not condemn a campaign whose resume pass sent nothing new', async () => {
    const writes: { update?: Record<string, unknown> } = {};
    // 800 delivered on the original pass, the 200-recipient resume all
    // failed: the campaign still reached 800 people.
    await finalizeBroadcastStatus(statusDb({ pending: 0, failed: 200 }, 1000, writes), 'b-1');
    expect(writes.update?.status).toBe('sent');
  });
});

// ============================================================
// deliverBroadcast
// ============================================================

interface Write {
  table: string;
  row: Record<string, unknown>;
  id?: unknown;
}

function deliveryDb(writes: Write[]): SupabaseClient {
  return {
    from(table: string) {
      const w: Write = { table, row: {} };
      const b: Record<string, unknown> = {
        select: () => b,
        update: (row: Record<string, unknown>) => {
          w.row = row;
          writes.push(w);
          return b;
        },
        eq: (col: string, val: unknown) => {
          if (col === 'id') w.id = val;
          return b;
        },
        // Count queries from finalizeBroadcastStatus: nothing pending.
        then: (resolve: (r: { count: number; error: null }) => unknown) =>
          resolve({ count: 0, error: null }),
      };
      return b;
    },
  } as unknown as SupabaseClient;
}

function plan(overrides: Partial<BroadcastPlan> = {}): BroadcastPlan {
  return {
    broadcastId: 'bc-1',
    templateName: 'promo',
    templateLanguage: 'pt_BR',
    phoneNumberId: 'pn-1',
    accessToken: 'tok',
    templateRow: null,
    headerMediaUrl: null,
    planned: [{ recipientRowId: 'r1', phone: '5511991234567', params: ['Ana'] }],
    ...overrides,
  };
}

describe('deliverBroadcast', () => {
  beforeEach(() => {
    sendTemplateMessage.mockReset();
  });

  it('sends the frozen params and stamps the row sent', async () => {
    sendTemplateMessage.mockResolvedValue({ messageId: 'wamid.1' });
    const writes: Write[] = [];
    await deliverBroadcast(deliveryDb(writes), plan());

    expect(sendTemplateMessage).toHaveBeenCalledWith(
      expect.objectContaining({ to: '5511991234567', params: ['Ana'], templateName: 'promo' }),
    );
    expect(sendTemplateMessage.mock.calls[0][0].messageParams).toBeUndefined();
    const stamp = writes.find((w) => w.table === 'broadcast_recipients');
    expect(stamp?.id).toBe('r1');
    expect(stamp?.row).toMatchObject({ status: 'sent', whatsapp_message_id: 'wamid.1' });
  });

  it('passes the wizard header media URL on every send', async () => {
    sendTemplateMessage.mockResolvedValue({ messageId: 'wamid.1' });
    await deliverBroadcast(
      deliveryDb([]),
      plan({ headerMediaUrl: 'https://cdn.test/a.jpg' }),
    );
    expect(sendTemplateMessage.mock.calls[0][0].messageParams).toEqual({
      headerMediaUrl: 'https://cdn.test/a.jpg',
    });
  });

  it('stamps a failed send with the Meta error and keeps going', async () => {
    sendTemplateMessage
      .mockRejectedValueOnce(new Error('(#131026) Message undeliverable'))
      .mockResolvedValueOnce({ messageId: 'wamid.2' });
    const writes: Write[] = [];
    await deliverBroadcast(
      deliveryDb(writes),
      plan({
        planned: [
          { recipientRowId: 'r1', phone: '5511991234567', params: [] },
          { recipientRowId: 'r2', phone: '5511998765432', params: [] },
        ],
      }),
    );
    const rows = writes.filter((w) => w.table === 'broadcast_recipients');
    expect(rows.map((w) => [w.id, w.row.status])).toEqual([
      ['r1', 'failed'],
      ['r2', 'sent'],
    ]);
    expect(rows[0].row.error_message).toContain('undeliverable');
  });

  it('renews the delivery lock while a long pass runs', async () => {
    sendTemplateMessage.mockResolvedValue({ messageId: 'wamid.x' });
    const writes: Write[] = [];
    const planned = Array.from({ length: DELIVERY_LOCK_HEARTBEAT_EVERY * 2 + 1 }, (_, i) => ({
      recipientRowId: `r${i}`,
      phone: '5511991234567',
      params: [],
    }));
    await deliverBroadcast(deliveryDb(writes), plan({ planned }));
    const heartbeats = writes.filter(
      (w) => w.table === 'broadcasts' && 'delivery_locked_at' in w.row,
    );
    expect(heartbeats).toHaveLength(2);
  });
});

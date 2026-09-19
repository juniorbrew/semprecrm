import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
const { send, configured } = vi.hoisted(() => ({
  send: vi.fn(),
  configured: vi.fn(),
}));
vi.mock('./send', () => ({
  sendPushToUsers: send,
  isPushConfigured: configured,
  truncateBody: (s: string) => s,
}));
import { notifyNewLeads } from './leads';

const lead = {
  id: 'lead1',
  kind: 'contato',
  name: 'Ana',
  email: 'ana@example.test',
  company: 'Empresa',
  notification_claim_token: 'token1',
};
function fixture(
  options: {
    receipts?: string[];
    admins?: string[];
    failComplete?: boolean;
  } = {}
) {
  const rpc = vi
    .fn()
    .mockImplementation(async (name: string) =>
      name === 'claim_lead_notifications'
        ? {
            data:
              rpc.mock.calls.filter(([n]) => n === name).length === 1
                ? [lead]
                : [],
            error: null,
          }
        : { data: !options.failComplete, error: null }
    );
  const upsert = vi.fn().mockResolvedValue({ error: null });
  const from = vi.fn((table: string) =>
    table === 'platform_admins'
      ? {
          select: async () => ({
            data: (options.admins ?? ['admin1']).map((user_id) => ({
              user_id,
            })),
            error: null,
          }),
        }
      : {
          select: () => ({
            eq: async () => ({
              data: (options.receipts ?? []).map((subscription_id) => ({
                subscription_id,
              })),
              error: null,
            }),
          }),
          upsert,
        }
  );
  return { client: { rpc, from } as unknown as SupabaseClient, rpc, upsert };
}
beforeEach(() => {
  configured.mockReturnValue(true);
  send
    .mockReset()
    .mockResolvedValue({
      configured: true,
      sent: 1,
      failed: 0,
      removed: 0,
      users: 1,
    });
});
describe('notifyNewLeads', () => {
  it('skips unconfigured push and absent recipients without claims', async () => {
    const f = fixture();
    configured.mockReturnValue(false);
    expect(await notifyNewLeads(f.client)).toEqual({
      claimed: 0,
      notified: 0,
      failed: 0,
    });
    expect(f.rpc).not.toHaveBeenCalled();
    configured.mockReturnValue(true);
    const empty = fixture({ admins: [] });
    await notifyNewLeads(empty.client);
    expect(empty.rpc).not.toHaveBeenCalled();
  });
  it('sends required pt-BR copy to real admins and fences success', async () => {
    const f = fixture();
    expect(await notifyNewLeads(f.client)).toEqual({
      claimed: 1,
      notified: 1,
      failed: 0,
    });
    expect(send).toHaveBeenCalledWith(
      f.client,
      ['admin1'],
      {
        title: 'Novo lead: Ana',
        body: 'Empresa',
        url: '/platform/leads',
        tag: 'lead:lead1',
      },
      expect.any(Object)
    );
    expect(f.rpc).toHaveBeenCalledWith('complete_lead_notification', {
      p_lead_id: 'lead1',
      p_claim_token: 'token1',
      p_success: true,
    });
  });
  it.each([
    { configured: true, sent: 0, failed: 1 },
    { configured: true, sent: 1, failed: 1 },
    { configured: true, sent: 0, failed: 0 },
    { configured: false, sent: 0, failed: 0 },
  ])(
    'releases failed/no-subscriber/partial delivery for retry: %j',
    async (result) => {
      send.mockResolvedValue(result);
      const f = fixture();
      expect((await notifyNewLeads(f.client)).notified).toBe(0);
      expect(f.rpc).toHaveBeenCalledWith(
        'complete_lead_notification',
        expect.objectContaining({ p_success: false })
      );
    }
  );
  it('retries exclude prior successes and persist each new receipt', async () => {
    const f = fixture({ receipts: ['subscription1'] });
    await notifyNewLeads(f.client);
    const delivery = send.mock.calls[0][3];
    expect(delivery.excludeSubscriptionIds).toEqual(['subscription1']);
    await delivery.onDelivered('subscription2');
    expect(f.upsert).toHaveBeenCalledWith(
      { lead_id: 'lead1', subscription_id: 'subscription2' },
      expect.objectContaining({ ignoreDuplicates: true })
    );
  });
  it('can finalize when all subscriptions already have receipts', async () => {
    send.mockResolvedValue({ configured: true, sent: 0, failed: 0 });
    const f = fixture({ receipts: ['subscription1'] });
    expect((await notifyNewLeads(f.client)).notified).toBe(1);
  });
  it('releases thrown send for retry and keeps draining', async () => {
    send.mockRejectedValue(new Error('network'));
    const f = fixture();
    expect((await notifyNewLeads(f.client)).failed).toBe(1);
    expect(f.rpc).toHaveBeenLastCalledWith('claim_lead_notifications', {
      p_limit: 1,
    });
  });
  it('does not report success for a lost lease', async () => {
    expect(
      (await notifyNewLeads(fixture({ failComplete: true }).client)).notified
    ).toBe(0);
  });
});

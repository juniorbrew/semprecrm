import { beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({
  authorize: vi.fn(),
  rpc: vi.fn(),
  admin: vi.fn(),
  account: vi.fn(),
}));
vi.mock('@/lib/platform/api', async () => ({
  ...(await vi.importActual('@/lib/platform/api')),
  authorizePlatformApi: h.authorize,
}));
vi.mock('@/lib/automations/admin-client', () => ({ supabaseAdmin: h.admin }));
vi.mock('@/lib/platform/server', () => ({ getPlatformAccount: h.account }));
import { PATCH } from './route';
const id = '39000000-0000-4000-8000-000000000001';
const call = (body: unknown) =>
  PATCH(
    new Request('http://localhost', {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ accountId: id }) }
  );
beforeEach(() => {
  vi.clearAllMocks();
  h.authorize.mockResolvedValue({ supabase: {}, user: { id } });
  h.admin.mockReturnValue({ rpc: h.rpc });
  h.rpc.mockResolvedValue({ error: null });
  h.account.mockResolvedValue({
    id,
    plan_version_id: id,
    plan_definition: { modules: [], limits: { max_users: 3, max_channels: 1 } },
  });
});
describe('company version mutation', () => {
  it.each([401, 403])(
    'checks both locks before service access (%s)',
    async (status) => {
      h.authorize.mockResolvedValue({
        response: new Response('{}', { status }),
      });
      expect((await call({})).status).toBe(status);
      expect(h.admin).not.toHaveBeenCalled();
    }
  );
  it('preserves terms for status-only edit and returns complete refreshed DTO', async () => {
    const res = await call({ plan_status: 'active' });
    expect(res.status).toBe(200);
    expect(h.rpc).toHaveBeenCalledWith(
      'platform_update_account_v2',
      expect.objectContaining({
        p_actor_user_id: id,
        p_adopt_current: false,
        p_expected_version_id: null,
        p_patch: { plan_status: 'active' },
      })
    );
    expect((await res.json()).account.plan_definition.limits.max_users).toBe(3);
  });
  it('sends adoption preview and maps stale terms to conflict', async () => {
    h.rpc.mockResolvedValue({ error: { code: '40001' } });
    expect(
      (await call({ adopt_current_plan: true, expected_plan_version_id: id }))
        .status
    ).toBe(409);
    expect(h.account).not.toHaveBeenCalled();
  });
  it('rejects actor injection and direct version assignment', async () => {
    expect((await call({ actor_user_id: id })).status).toBe(400);
    expect((await call({ plan_version_id: id })).status).toBe(400);
    expect(h.admin).not.toHaveBeenCalled();
  });
});

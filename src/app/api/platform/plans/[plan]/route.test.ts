import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PLAN_CATALOG } from '@/lib/plans';
const h = vi.hoisted(() => ({
  authorize: vi.fn(),
  rpc: vi.fn(),
  admin: vi.fn(),
  revalidate: vi.fn(),
  catalog: vi.fn(),
}));
vi.mock('@/lib/platform/api', async () => ({
  ...(await vi.importActual('@/lib/platform/api')),
  authorizePlatformApi: h.authorize,
}));
vi.mock('@/lib/automations/admin-client', () => ({ supabaseAdmin: h.admin }));
vi.mock('@/lib/plan-catalog-server', () => ({
  loadCurrentPlanCatalog: h.catalog,
}));
vi.mock('next/cache', () => ({ revalidatePath: h.revalidate }));
import { PATCH } from './route';
const id = '39000000-0000-4000-8000-000000000001';
const version = {
  id,
  plan: 'pro',
  revision: 1,
  definition: PLAN_CATALOG.pro,
  price_monthly_cents: 8990,
};
const request = (body: unknown) =>
  new Request('http://localhost/api/platform/plans/pro', {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
const body = {
  expected_version_id: id,
  definition: PLAN_CATALOG.pro,
  price_monthly_cents: 8990,
};
beforeEach(() => {
  vi.clearAllMocks();
  h.authorize.mockResolvedValue({ user: { id }, supabase: {} });
  h.admin.mockReturnValue({ rpc: h.rpc });
  h.rpc.mockResolvedValue({ data: [version], error: null });
});
describe('catalog save', () => {
  it.each([401, 403])(
    'denies unauthorized %s before privileged access',
    async (status) => {
      h.authorize.mockResolvedValue({
        response: new Response('{}', { status }),
      });
      expect(
        (
          await PATCH(request(body), {
            params: Promise.resolve({ plan: 'pro' }),
          })
        ).status
      ).toBe(status);
      expect(h.admin).not.toHaveBeenCalled();
    }
  );
  it('maps stale preview to conflict without invalidating prices', async () => {
    h.rpc.mockResolvedValue({ data: null, error: { code: '40001' } });
    expect(
      (await PATCH(request(body), { params: Promise.resolve({ plan: 'pro' }) }))
        .status
    ).toBe(409);
    expect(h.revalidate).not.toHaveBeenCalled();
  });
  it.each([
    { ...body, actor_user_id: id },
    { ...body, price_monthly_cents: 1.5 },
    {
      ...body,
      definition: {
        modules: ['inbox'],
        limits: { max_users: 1, max_channels: 1 },
      },
    },
  ])('rejects invalid inputs and actor impersonation', async (invalid) => {
    expect(
      (
        await PATCH(request(invalid), {
          params: Promise.resolve({ plan: 'pro' }),
        })
      ).status
    ).toBe(400);
    expect(h.admin).not.toHaveBeenCalled();
  });
  it('derives actor from session and projects only safe terms', async () => {
    h.rpc.mockResolvedValue({
      data: [{ ...version, actor_user_id: id, secret: 'hidden' }],
      error: null,
    });
    const response = await PATCH(request(body), {
      params: Promise.resolve({ plan: 'pro' }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ plan: version });
    expect(h.rpc).toHaveBeenCalledWith(
      'platform_save_plan_version',
      expect.objectContaining({ p_actor_user_id: id })
    );
    expect(h.revalidate).toHaveBeenCalledWith('/precos');
  });
});

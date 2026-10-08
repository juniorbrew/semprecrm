import { beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({
  authorize: vi.fn(),
  admin: vi.fn(),
  history: vi.fn(),
}));
vi.mock('@/lib/platform/api', async () => ({
  ...(await vi.importActual('@/lib/platform/api')),
  authorizePlatformApi: h.authorize,
}));
vi.mock('@/lib/automations/admin-client', () => ({ supabaseAdmin: h.admin }));
vi.mock('@/lib/plan-catalog-server', () => ({
  loadPlanVersionHistory: h.history,
}));
import { GET } from './route';
beforeEach(() => {
  vi.clearAllMocks();
  h.authorize.mockResolvedValue({ supabase: {}, user: { id: 'admin' } });
  h.history.mockResolvedValue({ items: [], nextCursor: null });
});
describe('plan revision history', () => {
  it.each([401, 403])(
    'denies access before service reads (%s)',
    async (status) => {
      h.authorize.mockResolvedValue({
        response: new Response('{}', { status }),
      });
      expect(
        (
          await GET(new Request('http://localhost'), {
            params: Promise.resolve({ plan: 'pro' }),
          })
        ).status
      ).toBe(status);
      expect(h.admin).not.toHaveBeenCalled();
    }
  );
  it.each(['0', '-1', '1.5', 'NaN', '9007199254740992'])(
    'rejects unsafe cursor %s',
    async (cursor) => {
      expect(
        (
          await GET(new Request('http://localhost?cursor=' + cursor), {
            params: Promise.resolve({ plan: 'pro' }),
          })
        ).status
      ).toBe(400);
      expect(h.admin).not.toHaveBeenCalled();
    }
  );
  it('returns scoped no-store page', async () => {
    const res = await GET(new Request('http://localhost?cursor=26'), {
      params: Promise.resolve({ plan: 'pro' }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(h.history).toHaveBeenCalledWith(undefined, 'pro', '26');
  });
});

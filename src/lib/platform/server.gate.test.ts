import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  getUser: vi.fn(),
  admin: vi.fn(),
  notFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
  redirect: vi.fn((to: string) => {
    throw new Error(`REDIRECT:${to}`);
  }),
}));
vi.mock('react', async (orig) => ({
  ...(await orig<typeof import('react')>()),
  cache: <T>(fn: T) => fn,
}));
vi.mock('next/navigation', () => ({
  notFound: mocks.notFound,
  redirect: mocks.redirect,
}));
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: mocks.getUser },
    rpc: mocks.rpc,
  }),
}));
vi.mock('@/lib/automations/admin-client', () => ({
  supabaseAdmin: mocks.admin,
}));
vi.mock('./gate', () => ({
  GATE_LOGIN_PATH: '/platform/login',
  loadGateCredentials: async () => ({}),
  hasGateSession: async () => true,
}));
import { getPlatformUsage, requirePlatformAdmin } from './server';

beforeEach(() => vi.clearAllMocks());

describe('the platform gate in front of /platform/usage', () => {
  it('answers not-found to a signed-out visitor', async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null } });
    await expect(requirePlatformAdmin()).rejects.toThrow('NEXT_NOT_FOUND');
    expect(mocks.admin).not.toHaveBeenCalled();
  });

  it.each(['agent', 'admin'])(
    'refuses a signed-in %s of a company (not a platform admin) and never reaches the service role',
    async () => {
      mocks.getUser.mockResolvedValue({
        data: { user: { id: 'tenant-user' } },
      });
      mocks.rpc.mockResolvedValue({ data: false, error: null });
      await expect(requirePlatformAdmin()).rejects.toThrow('NEXT_NOT_FOUND');
      expect(mocks.rpc).toHaveBeenCalledWith('is_platform_admin');
      expect(mocks.admin).not.toHaveBeenCalled();
    }
  );

  it('refuses when the admin check itself fails', async () => {
    mocks.getUser.mockResolvedValue({ data: { user: { id: 'u' } } });
    mocks.rpc.mockResolvedValue({ data: null, error: { message: 'boom' } });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(requirePlatformAdmin()).rejects.toThrow('NEXT_NOT_FOUND');
    expect(mocks.admin).not.toHaveBeenCalled();
  });
});

describe('getPlatformUsage (service role) checks the gate itself', () => {
  it('refuses a non-admin before creating the service client', async () => {
    mocks.getUser.mockResolvedValue({ data: { user: { id: 'tenant-user' } } });
    mocks.rpc.mockResolvedValue({ data: false, error: null });
    await expect(getPlatformUsage('2026-06')).rejects.toThrow('NEXT_NOT_FOUND');
    expect(mocks.admin).not.toHaveBeenCalled();
  });

  it('reads the month for the platform admin', async () => {
    mocks.getUser.mockResolvedValue({ data: { user: { id: 'owner' } } });
    mocks.rpc.mockResolvedValue({ data: true, error: null });
    const adminRpc = vi
      .fn()
      .mockResolvedValue({ data: [{ account_id: 'a' }], error: null });
    mocks.admin.mockReturnValue({ rpc: adminRpc });
    await expect(getPlatformUsage('2026-06')).resolves.toEqual([
      { account_id: 'a' },
    ]);
    expect(adminRpc).toHaveBeenCalledWith('platform_usage', {
      p_month: '2026-06-01',
    });
  });
});

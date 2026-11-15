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
import { requirePlatformAdmin } from './server';

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

import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ role: 'agent' as string, onList: new Set<string>(), asked: [] as unknown[] }));

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }));
vi.mock('@/lib/automations/admin-client', () => ({ supabaseAdmin: () => ({}) }));
vi.mock('@/lib/lgpd/suppression', () => ({
  findSuppressedPhones: vi.fn(async (_db: unknown, accountId: string, phones: string[]) => {
    h.asked.push({ accountId, phones });
    return new Set(phones.filter((p) => h.onList.has(p)));
  }),
}));
vi.mock('@/lib/auth/account', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/account')>();
  const { hasMinRole } = await import('@/lib/auth/roles');
  return {
    ...actual,
    requireRole: vi.fn(async (min: 'agent') => {
      if (!hasMinRole(h.role as 'agent', min)) throw new actual.ForbiddenError('Insufficient role');
      return { supabase: {}, userId: 'u-1', accountId: 'acc-1', role: h.role };
    }),
  };
});

import { __resetRateLimitForTests } from '@/lib/rate-limit';
import { POST } from './route';

const req = (body: unknown) =>
  new Request('http://x/api/contacts/suppressions/check', { method: 'POST', body: JSON.stringify(body) });

describe('POST /api/contacts/suppressions/check', () => {
  beforeEach(() => {
    __resetRateLimitForTests();
    h.role = 'agent';
    h.onList = new Set(['5511988880000']);
    h.asked = [];
  });

  it('returns the suppressed subset for the caller account', async () => {
    const res = await POST(req({ phones: ['5511999990000', '5511988880000'] }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ suppressed: ['5511988880000'] });
    expect(h.asked).toEqual([{ accountId: 'acc-1', phones: ['5511999990000', '5511988880000'] }]);
  });

  it('rejects viewers and malformed bodies without touching the list', async () => {
    h.role = 'viewer';
    expect((await POST(req({ phones: ['5511999990000'] }))).status).toBe(403);
    h.role = 'agent';
    expect((await POST(req({ phones: [] }))).status).toBe(400);
    expect((await POST(req({ phones: ['+55 11 9'] }))).status).toBe(400);
    expect((await POST(req({ phones: Array.from({ length: 501 }, (_, i) => String(i + 1)) }))).status).toBe(400);
    expect(h.asked).toEqual([]);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FakeDb } from '@/lib/whatsapp/fake-supabase.testkit';

const db = new FakeDb();

vi.mock('@/lib/auth/account', () => ({
  requireRole: vi.fn(async () => ({ supabase: db.client(), accountId: 'acct-1', userId: 'u-1' })),
  requireModule: vi.fn(async () => ({})),
  toErrorResponse: (e: unknown) => new Response(String(e), { status: 500 }),
}));

import { POST } from './route';

// The first lock token must come from the SERVER clock (round-2 review):
// a browser clock minutes off would make the lock look stale or fresh
// to every other pass.

describe('POST /api/whatsapp/broadcast/[id]/start', () => {
  beforeEach(() => {
    db.tables.clear();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-27T12:00:00.000Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('takes the lock with a token minted from the server clock', async () => {
    db.seed('broadcasts', [
      { id: 'bc-1', account_id: 'acct-1', status: 'sending', delivery_locked_at: null, delivery_protocol: 1 },
    ]);
    const res = await POST(new Request('http://x', { method: 'POST' }), {
      params: Promise.resolve({ id: 'bc-1' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.lock_token).toMatch(/^2026-09-27T12:00:00\.000\d{3}Z$/);
    expect(db.table('broadcasts')[0].delivery_locked_at).toBe(body.lock_token);
  });

  it('refuses (409) while another pass holds a fresh lock', async () => {
    db.seed('broadcasts', [
      {
        id: 'bc-1',
        account_id: 'acct-1',
        status: 'sending',
        delivery_locked_at: '2026-09-27T11:59:00.000123Z',
        delivery_protocol: 1,
      },
    ]);
    const res = await POST(new Request('http://x', { method: 'POST' }), {
      params: Promise.resolve({ id: 'bc-1' }),
    });
    expect(res.status).toBe(409);
    expect(db.table('broadcasts')[0].delivery_locked_at).toBe('2026-09-27T11:59:00.000123Z');
  });
});

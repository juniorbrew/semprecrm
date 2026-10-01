import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeFakeDb } from '@/lib/ai/fake-db.test-helper';

const h = vi.hoisted(() => ({
  db: null as unknown,
  pushes: [] as Record<string, unknown>[],
}));

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }));
vi.mock('@/lib/automations/admin-client', () => ({ supabaseAdmin: () => ({}) }));
vi.mock('@/lib/audit-server', () => ({ audit: vi.fn(async () => {}) }));
vi.mock('@/lib/push/notify', () => ({
  notifyAccountAdmins: vi.fn(async (_db: unknown, accountId: string, payload: Record<string, unknown>) => {
    h.pushes.push({ accountId, ...payload });
  }),
}));
vi.mock('@/lib/auth/account', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/account')>();
  return {
    ...actual,
    requireRole: vi.fn(async () => ({ supabase: h.db, userId: 'u-1', accountId: 'acc-1', role: 'admin', account: { id: 'acc-1', name: 'X' } })),
    requireModule: vi.fn(async () => ({})),
  };
});

import { __resetRateLimitForTests } from '@/lib/rate-limit';
import { PUT } from './route';

const put = (body: unknown) =>
  PUT(new Request('http://localhost/api/ai/settings', { method: 'PUT', body: JSON.stringify(body) }));

function world(settings: Record<string, unknown> | null) {
  h.db = makeFakeDb({
    ai_settings: settings ? [{ account_id: 'acc-1', enabled: false, model: null, instructions: null, monthly_budget_cents: 1000, suggest_history_messages: 20, consent_provider: null, consented_at: null, consented_by: null, ...settings }] : [],
    ai_provider_credentials_public: [],
    profiles: [],
  });
}

beforeEach(() => {
  __resetRateLimitForTests();
  h.pushes = [];
});

describe('PUT /api/ai/settings — provider change notice', () => {
  it('switching provider pushes owners / admins', async () => {
    world({ provider: 'openai', model: 'gpt-4.1-mini' });
    expect((await put({ provider: 'anthropic' })).status).toBe(200);
    expect(h.pushes).toHaveLength(1);
    expect(h.pushes[0]).toMatchObject({ accountId: 'acc-1', title: 'Provedor de IA alterado', url: '/settings?tab=ai' });
  });

  it('first setup (no provider before) and unrelated changes do not push', async () => {
    world(null);
    expect((await put({ provider: 'openai' })).status).toBe(200);
    world({ provider: null });
    expect((await put({ provider: 'openai' })).status).toBe(200);
    world({ provider: 'openai', model: 'gpt-4.1-mini' });
    expect((await put({ monthly_budget_cents: 500 })).status).toBe(200);
    expect(h.pushes).toHaveLength(0);
  });
});

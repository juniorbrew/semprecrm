import { beforeEach, describe, expect, it, vi } from 'vitest';

const KEY = 'sk-proj-SUPERSECRETKEY-0000000000000000-LAST';

const h = vi.hoisted(() => ({
  role: 'admin' as string,
  validate: vi.fn(),
  saved: [] as Record<string, unknown>[],
  audits: [] as Record<string, unknown>[],
  settingsUpdates: [] as Record<string, unknown>[],
  pushes: [] as Record<string, unknown>[],
}));

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }));
vi.mock('@/lib/automations/admin-client', () => ({ supabaseAdmin: () => ({}) }));
vi.mock('@/lib/audit-server', () => ({ audit: vi.fn(async (e: Record<string, unknown>) => h.audits.push(e)) }));
vi.mock('@/lib/push/notify', () => ({
  notifyAccountAdmins: vi.fn(async (_db: unknown, accountId: string, payload: Record<string, unknown>) => {
    h.pushes.push({ accountId, ...payload });
    return { users: 1, sent: 1, failed: 0, removed: 0, configured: true };
  }),
}));
vi.mock('@/lib/ai/client', () => ({ validateProviderKey: h.validate }));
vi.mock('@/lib/ai/store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ai/store')>();
  return {
    ...actual,
    saveCredential: vi.fn(async (_db: unknown, args: Record<string, unknown>) => {
      const enc = actual.encryptApiKey(args.apiKey as string);
      h.saved.push({ ...args, ...enc });
      return { provider: args.provider, last4: enc.last4, validated_at: args.validatedAt, updated_at: null };
    }),
    deleteCredential: vi.fn(async () => true),
    loadDecryptedKey: vi.fn(async () => null),
  };
});
vi.mock('@/lib/auth/account', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/account')>();
  const { hasMinRole } = await import('@/lib/auth/roles');
  const b = {
    update: (p: Record<string, unknown>) => {
      h.settingsUpdates.push(p);
      return b;
    },
    eq: () => b,
    then: (r: (v: { error: null }) => unknown) => r({ error: null }),
  };
  return {
    ...actual,
    requireRole: vi.fn(async (min: 'admin') => {
      if (!hasMinRole(h.role as 'admin', min)) throw new actual.ForbiddenError('Insufficient role');
      return { supabase: { from: () => b }, userId: 'u-1', accountId: 'acc-1', role: h.role, account: { id: 'acc-1', name: 'X' } };
    }),
    requireModule: vi.fn(async () => ({})),
  };
});

import { __resetRateLimitForTests } from '@/lib/rate-limit';
import { DELETE, POST } from './route';

function post(body: unknown) {
  return POST(new Request('http://localhost/api/ai/credentials', { method: 'POST', body: JSON.stringify(body) }));
}

beforeEach(() => {
  __resetRateLimitForTests();
  h.role = 'admin';
  h.saved = [];
  h.audits = [];
  h.settingsUpdates = [];
  h.pushes = [];
  h.validate.mockResolvedValue({ ok: true, models: ['gpt-4.1-mini'] });
});

describe('/api/ai/credentials', () => {
  it('validates, stores encrypted and returns only last4', async () => {
    const res = await post({ provider: 'openai', api_key: KEY });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain('SUPERSECRET');
    expect(JSON.parse(text).credential).toMatchObject({ provider: 'openai', last4: 'LAST' });
    expect(h.validate).toHaveBeenCalledWith('openai', KEY);
    expect(h.saved[0].accountId).toBe('acc-1');
    expect(String(h.saved[0].api_key_enc)).not.toContain('SUPERSECRET');
    expect(JSON.stringify(h.audits)).not.toContain('SUPERSECRET');
    expect(h.audits[0]).toMatchObject({ action: 'ai.key_saved', metadata: { provider: 'openai', last4: 'LAST' } });
    // owners / admins are told; the key itself never goes in the push
    expect(h.pushes).toHaveLength(1);
    expect(h.pushes[0]).toMatchObject({ accountId: 'acc-1', title: 'Chave de IA alterada', url: '/settings?tab=ai' });
    expect(String(h.pushes[0].body)).toContain('final LAST');
    expect(JSON.stringify(h.pushes)).not.toContain('SUPERSECRET');
  });

  it('a re-test of the saved key or a rejected key notifies nobody', async () => {
    h.validate.mockResolvedValue({ ok: false, code: 'invalid_key' });
    await post({ provider: 'openai', api_key: KEY });
    expect(h.pushes).toHaveLength(0);
  });

  it('does not save a key the provider rejects', async () => {
    h.validate.mockResolvedValue({ ok: false, code: 'invalid_key' });
    const res = await post({ provider: 'anthropic', api_key: KEY });
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('invalid_key');
    expect(h.saved).toHaveLength(0);
  });

  it('rejects unknown providers, junk keys and non-admins', async () => {
    expect((await post({ provider: 'gemini', api_key: KEY })).status).toBe(400);
    expect((await post({ provider: 'openai', api_key: 'short' })).status).toBe(400);
    expect((await post({ provider: 'openai' })).status).toBe(404); // nothing saved to re-test
    h.role = 'agent';
    expect((await post({ provider: 'openai', api_key: KEY })).status).toBe(403);
    expect(h.validate).not.toHaveBeenCalled();
  });

  it('delete removes the key and switches AI off for that provider', async () => {
    const res = await DELETE(new Request('http://localhost/api/ai/credentials?provider=openai', { method: 'DELETE' }));
    expect(res.status).toBe(200);
    expect(h.settingsUpdates[0]).toMatchObject({ enabled: false });
    expect(h.audits[0]).toMatchObject({ action: 'ai.key_removed' });
    expect(h.pushes[0]).toMatchObject({ accountId: 'acc-1', title: 'Chave de IA removida' });
  });
});

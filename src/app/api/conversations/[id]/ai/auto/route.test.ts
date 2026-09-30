import { beforeEach, describe, expect, it, vi } from 'vitest';

// /api/conversations/:id/ai/auto — roles, module, account isolation,
// pause / resume and the re-enqueue on resume.

const CONV = '11111111-1111-4111-8111-111111111111';

const h = vi.hoisted(() => ({
  role: 'agent' as string | null,
  aiModule: true,
  enqueue: vi.fn(async () => true),
  after: vi.fn(),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: null as any,
}));

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }));
vi.mock('next/server', async (orig) => ({ ...(await orig<typeof import('next/server')>()), after: h.after }));
vi.mock('@/lib/automations/admin-client', () => ({ supabaseAdmin: () => h.db.client() }));
vi.mock('@/lib/ai/auto-reply-runtime', () => ({
  enqueueAutoReplyIfEligible: h.enqueue,
  kickAutoReplies: vi.fn(),
  resolveConversationAgent: vi.fn(async () => ({ id: 'ag', name: 'Bia', mode: 'auto', paused_at: null })),
}));
vi.mock('@/lib/auth/account', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/account')>();
  const { hasMinRole } = await import('@/lib/auth/roles');
  return {
    ...actual,
    requireRole: vi.fn(async (min: 'agent') => {
      if (!h.role) throw new actual.UnauthorizedError();
      if (!hasMinRole(h.role as 'agent', min)) throw new actual.ForbiddenError('Insufficient role');
      return { supabase: h.db.client(), userId: 'user-a', accountId: 'acc-a', role: h.role };
    }),
    requireModule: vi.fn(async () => {
      if (!h.aiModule) throw new actual.ModuleNotIncludedError('ai');
      return {};
    }),
  };
});

import { FakeDb } from '@/lib/whatsapp/fake-supabase.testkit';
import { GET, POST } from './route';

const params = (id = CONV) => ({ params: Promise.resolve({ id }) });
const post = (body: unknown, id = CONV) =>
  POST(new Request('http://x', { method: 'POST', body: JSON.stringify(body) }), params(id));

beforeEach(() => {
  h.role = 'agent';
  h.aiModule = true;
  h.enqueue.mockClear();
  h.after.mockClear();
  h.db = new FakeDb();
  h.db.seed('conversations', [
    { id: CONV, account_id: 'acc-a', user_id: 'o', contact_id: 'ct', status: 'open', channel: 'qr', ai_paused_until: null },
  ]);
  h.db.seed('contacts', [{ id: 'ct', account_id: 'acc-a', opted_out_at: null, anonymized_at: null }]);
  h.db.seed('messages', [
    { id: 'm1', conversation_id: CONV, sender_type: 'agent', created_at: '2026-09-29T10:00:00Z' },
    { id: 'm2', conversation_id: CONV, sender_type: 'customer', created_at: '2026-09-29T10:05:00Z' },
  ]);
});

describe('POST pause / resume', () => {
  it('viewer is refused, bad action is 400, other account is 404', async () => {
    h.role = 'viewer';
    expect((await post({ action: 'pause' })).status).toBe(403);
    h.role = 'agent';
    expect((await post({ action: 'nope' })).status).toBe(400);
    h.db.table('conversations')[0].account_id = 'acc-b';
    expect((await post({ action: 'pause' })).status).toBe(404);
  });

  it('module off → 403', async () => {
    h.aiModule = false;
    expect((await post({ action: 'pause' })).status).toBe(403);
  });

  it('pause sets infinity and logs the pill', async () => {
    const res = await post({ action: 'pause' });
    expect(res.status).toBe(200);
    expect(h.db.table('conversations')[0].ai_paused_until).toBe('infinity');
    expect(h.db.table('conversation_events')[0]).toMatchObject({ event_type: 'ai_paused', actor_user_id: 'user-a' });
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it('resume clears the pause and re-enqueues the unanswered message', async () => {
    h.db.table('conversations')[0].ai_paused_until = 'infinity';
    const res = await post({ action: 'resume' });
    expect(await res.json()).toMatchObject({ paused: false, queued: true });
    expect(h.db.table('conversations')[0].ai_paused_until).toBeNull();
    expect(h.enqueue).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ messageIds: ['m2'] }));
    expect(h.after).toHaveBeenCalledTimes(1);
  });

  it('resume skips messages a finished AI job already answered, even with an older timestamp than its bubble', async () => {
    h.db.table('messages').push(
      { id: 'ai1', conversation_id: CONV, sender_type: 'bot', origin: 'ai', created_at: '2026-09-29T10:05:01Z' },
      { id: 'm4', conversation_id: CONV, sender_type: 'customer', created_at: '2026-09-29T10:05:00Z' },
    );
    h.db.seed('ai_reply_jobs', [{ id: 'j', conversation_id: CONV, status: 'done', inbound_message_ids: ['m2'] }]);
    await post({ action: 'resume' });
    expect(h.enqueue).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ messageIds: ['m4'] }));
  });

  it('resume with nothing unanswered does not enqueue', async () => {
    h.db.table('messages').push({ id: 'm3', conversation_id: CONV, sender_type: 'agent', created_at: '2026-09-29T10:06:00Z' });
    await post({ action: 'resume' });
    expect(h.enqueue).not.toHaveBeenCalled();
  });
});

describe('GET', () => {
  it('any member reads the state; handoff shown while stopped by it', async () => {
    h.role = 'viewer';
    h.db.table('conversations')[0].ai_paused_until = 'infinity';
    h.db.seed('ai_handoffs', [{ id: 'h1', account_id: 'acc-a', conversation_id: CONV, reason: 'r', notified: true, created_at: '2026-09-29T10:06:00Z' }]);
    const body = await (await GET(new Request('http://x'), params())).json();
    expect(body).toMatchObject({ applies: true, paused: true, handling: false, handoff: { id: 'h1' } });
  });

  it('without the module: applies false (no error)', async () => {
    h.aiModule = false;
    const body = await (await GET(new Request('http://x'), params())).json();
    expect(body).toMatchObject({ applies: false, handoff: null });
  });
});

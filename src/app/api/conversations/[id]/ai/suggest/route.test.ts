import { beforeEach, describe, expect, it, vi } from 'vitest';

// ------------------------------------------------------------
// POST /api/conversations/:id/ai/suggest
//
// The session context, a tiny in-memory PostgREST-ish client and
// runModelCall are mocked; what is tested is the route's gatekeeping
// (auth, role, module, account isolation, LGPD) and what it sends to
// the model.
// ------------------------------------------------------------

type Row = Record<string, unknown>;

const h = vi.hoisted(() => ({
  state: {
    role: 'agent' as string | null,
    aiModule: true,
    tables: {} as Record<string, Row[]>,
  },
  runModelCall: vi.fn(),
}));

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }));
vi.mock('@/lib/automations/admin-client', () => ({ supabaseAdmin: () => ({ admin: true }) }));
vi.mock('@/lib/ai/run-model-call', () => ({ runModelCall: h.runModelCall }));

/** Minimal query builder: select/eq/order/limit/maybeSingle/await. */
function makeSupabase() {
  return {
    from(table: string) {
      let rows = [...(h.state.tables[table] ?? [])];
      const b = {
        select: () => b,
        eq: (col: string, val: unknown) => {
          rows = rows.filter((r) => r[col] === val);
          return b;
        },
        order: (col: string, opts: { ascending: boolean }) => {
          rows.sort((a, z) => String(a[col]).localeCompare(String(z[col])) * (opts.ascending ? 1 : -1));
          return b;
        },
        limit: (n: number) => {
          rows = rows.slice(0, n);
          return b;
        },
        maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
        then: (resolve: (v: { data: Row[]; error: null }) => unknown) => resolve({ data: rows, error: null }),
      };
      return b;
    },
  };
}

vi.mock('@/lib/auth/account', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/account')>();
  const { hasMinRole } = await import('@/lib/auth/roles');
  return {
    ...actual,
    requireRole: vi.fn(async (min: 'agent') => {
      if (!h.state.role) throw new actual.UnauthorizedError();
      if (!hasMinRole(h.state.role as 'agent', min)) throw new actual.ForbiddenError('Insufficient role');
      return {
        supabase: makeSupabase(),
        userId: 'user-a',
        accountId: 'acc-a',
        role: h.state.role,
        account: { id: 'acc-a', name: 'Padaria Sol' },
      };
    }),
    requireModule: vi.fn(async () => {
      if (!h.state.aiModule) throw new actual.ModuleNotIncludedError('ai');
      return {};
    }),
  };
});

import { __resetRateLimitForTests } from '@/lib/rate-limit';
import { AiError } from '@/lib/ai/errors';
import { HISTORY_CLOSE, HISTORY_OPEN } from '@/lib/ai/suggest-reply';
import { POST } from './route';

const CONV_A = '11111111-1111-4111-8111-111111111111';
const CONV_A2 = '22222222-2222-4222-8222-222222222222';
const CONV_B = '33333333-3333-4333-8333-333333333333';
const CONV_ANON = '44444444-4444-4444-8444-444444444444';

function post(id: string, body: unknown = {}) {
  return POST(
    new Request(`http://localhost/api/conversations/${id}/ai/suggest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );
}

beforeEach(() => {
  __resetRateLimitForTests();
  h.state.role = 'agent';
  h.state.aiModule = true;
  h.state.tables = {
    conversations: [
      { id: CONV_A, account_id: 'acc-a', contact: { name: 'Maria', anonymized_at: null } },
      { id: CONV_A2, account_id: 'acc-a', contact: { name: 'João', anonymized_at: null } },
      { id: CONV_B, account_id: 'acc-b', contact: { name: 'Zoe', anonymized_at: null } },
      { id: CONV_ANON, account_id: 'acc-a', contact: { name: null, anonymized_at: '2026-09-01T00:00:00Z' } },
    ],
    ai_settings: [
      { account_id: 'acc-a', enabled: true, instructions: 'Entregamos no bairro.', suggest_history_messages: 20 },
      { account_id: 'acc-b', enabled: true, instructions: 'SEGREDO DA CONTA B', suggest_history_messages: 20 },
    ],
    messages: [
      { conversation_id: CONV_A, sender_type: 'customer', content_type: 'text', content_text: 'Vocês entregam hoje?', created_at: '2026-09-28T10:00:00Z' },
      { conversation_id: CONV_A, sender_type: 'agent', content_type: 'text', content_text: 'Oi Maria!', created_at: '2026-09-28T10:01:00Z' },
      { conversation_id: CONV_A, sender_type: 'agent', content_type: 'text', content_text: 'ENVIO QUE FALHOU', status: 'failed', created_at: '2026-09-28T10:01:30Z' },
      { conversation_id: CONV_A2, sender_type: 'customer', content_type: 'text', content_text: 'MENSAGEM DE OUTRA CONVERSA', created_at: '2026-09-28T10:02:00Z' },
      { conversation_id: CONV_B, sender_type: 'customer', content_type: 'text', content_text: 'MENSAGEM DA CONTA B', created_at: '2026-09-28T10:03:00Z' },
    ],
  };
  h.runModelCall.mockResolvedValue({ text: 'Entregamos sim! Qual o endereço?' });
});

describe('POST /api/conversations/:id/ai/suggest', () => {
  it('returns the suggestion for a conversation of the caller account', async () => {
    const res = await post(CONV_A, { accountId: 'acc-b' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ text: 'Entregamos sim! Qual o endereço?' });

    expect(h.runModelCall).toHaveBeenCalledOnce();
    const input = h.runModelCall.mock.calls[0][0];
    expect(input.accountId).toBe('acc-a');
    expect(input.userId).toBe('user-a');
    expect(input.conversationId).toBe(CONV_A);
    expect(input.feature).toBe('suggest_reply');
    expect(input.prompt).toContain(HISTORY_OPEN);
    expect(input.prompt).toContain(HISTORY_CLOSE);
    expect(input.prompt).toContain('Vocês entregam hoje?');
    expect(input.prompt.indexOf('Vocês entregam hoje?')).toBeLessThan(input.prompt.indexOf('Oi Maria!'));
    expect(input.prompt).not.toContain('MENSAGEM DE OUTRA CONVERSA');
    expect(input.prompt).not.toContain('ENVIO QUE FALHOU');
    expect(input.prompt).not.toContain('MENSAGEM DA CONTA B');
    expect(input.system).toContain('Entregamos no bairro.');
    expect(input.system).not.toContain('SEGREDO DA CONTA B');
    expect(input.system).toContain('Padaria Sol');
  });

  it('401 without a session', async () => {
    h.state.role = null;
    expect((await post(CONV_A)).status).toBe(401);
  });

  it('403 for viewers', async () => {
    h.state.role = 'viewer';
    expect((await post(CONV_A)).status).toBe(403);
    expect(h.runModelCall).not.toHaveBeenCalled();
  });

  it('403 module_not_included when the plan lacks AI', async () => {
    h.state.aiModule = false;
    const res = await post(CONV_A);
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('module_not_included');
  });

  it("404 for another account's conversation (and for bad ids)", async () => {
    expect((await post(CONV_B)).status).toBe(404);
    expect((await post('not-a-uuid')).status).toBe(404);
    expect(h.runModelCall).not.toHaveBeenCalled();
  });

  it('403 for an anonymized contact', async () => {
    const res = await post(CONV_ANON);
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('contact_anonymized');
    expect(h.runModelCall).not.toHaveBeenCalled();
  });

  it('409 when AI is not enabled for the account', async () => {
    h.state.tables.ai_settings[0].enabled = false;
    const res = await post(CONV_A);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('not_enabled');
    expect(h.runModelCall).not.toHaveBeenCalled();
  });

  it('422 when the conversation has no messages', async () => {
    h.state.tables.messages = [];
    const res = await post(CONV_A);
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('no_messages');
  });

  it('respects the history window', async () => {
    h.state.tables.ai_settings[0].suggest_history_messages = 1;
    await post(CONV_A);
    const prompt: string = h.runModelCall.mock.calls[0][0].prompt;
    expect(prompt).toContain('Oi Maria!');
    expect(prompt).not.toContain('Vocês entregam hoje?');
  });

  it('maps AI errors to their status and message', async () => {
    h.runModelCall.mockRejectedValueOnce(new AiError('budget_exceeded'));
    const res = await post(CONV_A);
    expect(res.status).toBe(402);
    const body = await res.json();
    expect(body.code).toBe('budget_exceeded');
    expect(body.error).toMatch(/budget/);
  });

  it('rate-limits per user', async () => {
    for (let i = 0; i < 10; i++) expect((await post(CONV_A)).status).toBe(200);
    expect((await post(CONV_A)).status).toBe(429);
  });
});

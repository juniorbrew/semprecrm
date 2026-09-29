import { beforeEach, describe, expect, it, vi } from 'vitest';

// ------------------------------------------------------------
// /api/ai/agents, /api/ai/agents/:id, /api/ai/agents/:id/test (064).
// Session context, an in-memory client and runModelCall are mocked.
// ------------------------------------------------------------

type Row = Record<string, unknown>;

const h = vi.hoisted(() => ({
  role: 'admin' as string | null,
  aiModule: true,
  tables: {} as Record<string, Row[]>,
  runModelCall: vi.fn(),
  audits: [] as Row[],
}));

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }));
vi.mock('@/lib/automations/admin-client', () => ({ supabaseAdmin: () => ({ admin: true }) }));
vi.mock('@/lib/audit-server', () => ({ audit: vi.fn(async (e: Row) => h.audits.push(e)) }));
vi.mock('@/lib/ai/run-model-call', () => ({ runModelCall: h.runModelCall }));

vi.mock('@/lib/auth/account', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/account')>();
  const { hasMinRole } = await import('@/lib/auth/roles');
  const { makeFakeDb } = await import('@/lib/ai/fake-db.test-helper');
  return {
    ...actual,
    requireRole: vi.fn(async (min: 'admin') => {
      if (!h.role) throw new actual.UnauthorizedError();
      if (!hasMinRole(h.role as 'admin', min)) throw new actual.ForbiddenError('Insufficient role');
      return {
        supabase: makeFakeDb(h.tables, async () => ({ data: [], error: null })),
        userId: 'u-a',
        accountId: 'acc-a',
        role: h.role,
        account: { id: 'acc-a', name: 'Padaria Sol' },
      };
    }),
    requireModule: vi.fn(async () => {
      if (!h.aiModule) throw new actual.ModuleNotIncludedError('ai');
      return {};
    }),
  };
});

import { __resetRateLimitForTests } from '@/lib/rate-limit';
import { AGENT_ERRORS } from '@/lib/ai/agents';
import { GET, POST } from './route';
import { DELETE, PATCH } from './[id]/route';
import { POST as TEST } from './[id]/test/route';

const AG_A = '11111111-1111-4111-8111-111111111111';
const AG_A2 = '22222222-2222-4222-8222-222222222222';
const AG_B = '33333333-3333-4333-8333-333333333333';

const req = (body?: unknown, method = 'POST') =>
  new Request('http://localhost/api/ai/agents', {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const p = (id: string) => ({ params: Promise.resolve({ id }) });
const agent = (id: string) => h.tables.ai_agents.find((a) => a.id === id);

beforeEach(() => {
  __resetRateLimitForTests();
  h.role = 'admin';
  h.aiModule = true;
  h.audits = [];
  h.runModelCall.mockReset();
  h.tables = {
    ai_settings: [{ account_id: 'acc-a', provider: 'openai' }],
    ai_agents: [
      { id: AG_A, account_id: 'acc-a', name: 'Vendas', instructions: 'Venda', tone: null, model: null, knowledge_enabled: false, is_default: true, enabled: true, channels: [], tag_ids: [], created_at: '1' },
      { id: AG_A2, account_id: 'acc-a', name: 'Suporte', instructions: 'Ajude', tone: 'calmo', model: 'gpt-4.1', knowledge_enabled: true, is_default: false, enabled: true, channels: ['qr'], tag_ids: [], created_at: '2' },
      { id: AG_B, account_id: 'acc-b', name: 'B', instructions: 'SEGREDO B', is_default: true, enabled: true, channels: [], tag_ids: [], created_at: '0' },
    ],
  };
});

describe('auth', () => {
  it('agents and viewers are refused (403); no session 401; no module 403', async () => {
    for (const role of ['agent', 'viewer']) {
      h.role = role;
      expect((await GET()).status).toBe(403);
      expect((await POST(req({ name: 'x', instructions: 'y' }))).status).toBe(403);
      expect((await PATCH(req({ enabled: false }, 'PATCH'), p(AG_A))).status).toBe(403);
      expect((await DELETE(req(undefined, 'DELETE'), p(AG_A))).status).toBe(403);
      expect((await TEST(req({ message: 'oi' }), p(AG_A))).status).toBe(403);
    }
    h.role = null;
    expect((await GET()).status).toBe(401);
    h.role = 'admin';
    h.aiModule = false;
    expect((await GET()).status).toBe(403);
    expect(h.tables.ai_agents).toHaveLength(3);
  });
});

describe('CRUD', () => {
  it('lists only the account agents, oldest first', async () => {
    const { agents } = await (await GET()).json();
    expect(agents.map((a: Row) => a.id)).toEqual([AG_A, AG_A2]);
  });

  it('creates an agent; a new default clears the previous one of THIS account only', async () => {
    const res = await POST(req({ name: 'VIP', instructions: 'Trate bem', is_default: true, channels: ['official'], accountId: 'acc-b' }));
    expect(res.status).toBe(201);
    const { agent: created } = await res.json();
    expect(created).toMatchObject({ account_id: 'acc-a', name: 'VIP', is_default: true, created_by: 'u-a' });
    expect(agent(AG_A)?.is_default).toBe(false);
    expect(agent(AG_B)?.is_default).toBe(true);
    expect(h.audits[0]).toMatchObject({ action: 'ai.agents_changed', metadata: { op: 'created' } });
  });

  it('validates the body and the model provider', async () => {
    expect((await POST(req({ name: '', instructions: 'x' }))).status).toBe(400);
    const res = await POST(req({ name: 'x', instructions: 'y', model: 'claude-haiku-4-5' }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('This model does not belong to the selected provider');
  });

  it('caps agents per account', async () => {
    for (let i = 0; i < 18; i++) h.tables.ai_agents.push({ id: `x${i}`, account_id: 'acc-a' });
    const res = await POST(req({ name: 'x', instructions: 'y' }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe(AGENT_ERRORS.tooMany);
  });

  it('PATCH edits, swaps the default, and never touches another account', async () => {
    const res = await PATCH(req({ is_default: true, enabled: false, tag_ids: [AG_B] }, 'PATCH'), p(AG_A2));
    expect(res.status).toBe(200);
    expect(agent(AG_A2)).toMatchObject({ is_default: true, enabled: false, tag_ids: [AG_B] });
    expect(agent(AG_A)?.is_default).toBe(false);
    expect((await PATCH(req({ name: 'hijack' }, 'PATCH'), p(AG_B))).status).toBe(404);
    expect(agent(AG_B)?.name).toBe('B');
  });

  it('DELETE removes own agents only', async () => {
    expect((await DELETE(req(undefined, 'DELETE'), p(AG_B))).status).toBe(404);
    expect((await DELETE(req(undefined, 'DELETE'), p(AG_A))).status).toBe(200);
    expect(h.tables.ai_agents.map((a) => a.id)).toEqual([AG_A2, AG_B]);
  });
});

describe('POST /api/ai/agents/:id/test', () => {
  it('one budgeted model call with the agent instructions, tone and model', async () => {
    h.runModelCall.mockResolvedValue({ text: 'Olá! Posso ajudar?' });
    const res = await TEST(req({ message: 'Vocês abrem domingo?' }), p(AG_A2));
    expect(await res.json()).toEqual({ text: 'Olá! Posso ajudar?' });
    const input = h.runModelCall.mock.calls[0][0];
    expect(input).toMatchObject({ accountId: 'acc-a', feature: 'agent_test', conversationId: null, model: 'gpt-4.1' });
    expect(input.system).toContain('Ajude');
    expect(input.system).toContain('Tom de voz: calmo');
    expect(input.prompt).toContain('{"de":"cliente","texto":"Vocês abrem domingo?"}');
  });

  it('refuses an empty message and a foreign agent', async () => {
    expect((await TEST(req({ message: '  ' }), p(AG_A))).status).toBe(400);
    expect((await TEST(req({ message: 'oi' }), p(AG_B))).status).toBe(404);
    expect(h.runModelCall).not.toHaveBeenCalled();
  });
});

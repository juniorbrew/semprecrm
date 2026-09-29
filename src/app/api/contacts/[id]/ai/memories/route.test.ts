import { beforeEach, describe, expect, it, vi } from 'vitest';

// ------------------------------------------------------------
// "Memória do contato" routes (migration 064):
//   /api/contacts/:id/ai/memories            GET (viewer+) / POST (agent+)
//   /api/contacts/:id/ai/memories/:memoryId  PATCH / DELETE (agent+)
//   /api/conversations/:id/ai/memory         POST extract (agent+)
// Session context, an in-memory client and runModelCall are mocked.
// ------------------------------------------------------------

type Row = Record<string, unknown>;

const h = vi.hoisted(() => ({
  role: 'agent' as string | null,
  aiModule: true,
  tables: {} as Record<string, Row[]>,
  runModelCall: vi.fn(),
}));

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }));
vi.mock('@/lib/automations/admin-client', () => ({ supabaseAdmin: () => ({ admin: true }) }));
vi.mock('@/lib/ai/run-model-call', () => ({ runModelCall: h.runModelCall }));

vi.mock('@/lib/auth/account', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/account')>();
  const { hasMinRole } = await import('@/lib/auth/roles');
  const { makeFakeDb } = await import('@/lib/ai/fake-db.test-helper');
  return {
    ...actual,
    requireRole: vi.fn(async (min: 'agent') => {
      if (!h.role) throw new actual.UnauthorizedError();
      if (!hasMinRole(h.role as 'agent', min)) throw new actual.ForbiddenError('Insufficient role');
      return {
        supabase: makeFakeDb(h.tables),
        userId: 'user-a',
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
import { AiError } from '@/lib/ai/errors';
import { MEMORY_ERRORS } from '@/lib/ai/memory';
import { GET, POST } from './route';
import { DELETE, PATCH } from './[memoryId]/route';
import { POST as EXTRACT } from '../../../../conversations/[id]/ai/memory/route';

const CT_A = '11111111-1111-4111-8111-111111111111';
const CT_B = '22222222-2222-4222-8222-222222222222';
const CT_ANON = '33333333-3333-4333-8333-333333333333';
const CONV_A = '44444444-4444-4444-8444-444444444444';
const CONV_B = '55555555-5555-4555-8555-555555555555';
const M_PROPOSED = '66666666-6666-4666-8666-666666666666';
const M_ACTIVE = '77777777-7777-4777-8777-777777777777';
const M_B = '88888888-8888-4888-8888-888888888888';

const req = (body?: unknown, method = 'POST') =>
  new Request('http://localhost/x', {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const p = <T extends Record<string, string>>(v: T) => ({ params: Promise.resolve(v) });

beforeEach(() => {
  __resetRateLimitForTests();
  h.role = 'agent';
  h.aiModule = true;
  h.runModelCall.mockReset();
  h.tables = {
    contacts: [
      { id: CT_A, account_id: 'acc-a', anonymized_at: null },
      { id: CT_B, account_id: 'acc-b', anonymized_at: null },
      { id: CT_ANON, account_id: 'acc-a', anonymized_at: '2026-09-01T00:00:00Z' },
    ],
    conversations: [
      { id: CONV_A, account_id: 'acc-a', channel: 'official', contact_id: CT_A, contact: { name: 'Maria', anonymized_at: null } },
      { id: CONV_B, account_id: 'acc-b', channel: 'official', contact_id: CT_B, contact: { name: 'Zoe', anonymized_at: null } },
    ],
    ai_settings: [{ account_id: 'acc-a', enabled: true, instructions: null, suggest_history_messages: 20 }],
    messages: [
      { conversation_id: CONV_A, sender_type: 'customer', content_type: 'text', content_text: 'Sou do buffet Sol, entreguem à tarde', created_at: '1' },
    ],
    ai_contact_memories: [
      { id: M_PROPOSED, account_id: 'acc-a', contact_id: CT_A, fact: 'Trabalha com eventos', status: 'proposed', source: 'ai', created_at: '2', updated_at: '2' },
      { id: M_ACTIVE, account_id: 'acc-a', contact_id: CT_A, fact: 'Prefere entrega à tarde', status: 'active', source: 'manual', created_at: '1', updated_at: '1' },
      { id: 'rej', account_id: 'acc-a', contact_id: CT_A, fact: 'Gosta de bolo de cenoura', status: 'rejected', source: 'ai', created_at: '0', updated_at: '0' },
      { id: M_B, account_id: 'acc-b', contact_id: CT_B, fact: 'SEGREDO B', status: 'active', source: 'manual', created_at: '1', updated_at: '1' },
    ],
  };
});

const mem = (id: string) => h.tables.ai_contact_memories.find((m) => m.id === id);

describe('GET /api/contacts/:id/ai/memories', () => {
  it('viewer reads proposed + active facts (never rejected)', async () => {
    h.role = 'viewer';
    const res = await GET(req(undefined, 'GET'), p({ id: CT_A }));
    expect(res.status).toBe(200);
    const { memories } = await res.json();
    expect(memories.map((m: Row) => m.id)).toEqual([M_PROPOSED, M_ACTIVE]);
  });

  it("another account's contact is 404; no session 401; no module 403", async () => {
    expect((await GET(req(undefined, 'GET'), p({ id: CT_B }))).status).toBe(404);
    expect((await GET(req(undefined, 'GET'), p({ id: 'x' }))).status).toBe(404);
    h.aiModule = false;
    expect((await GET(req(undefined, 'GET'), p({ id: CT_A }))).status).toBe(403);
    h.role = null;
    expect((await GET(req(undefined, 'GET'), p({ id: CT_A }))).status).toBe(401);
  });
});

describe('POST /api/contacts/:id/ai/memories (manual)', () => {
  it('agent adds an active fact stamped with the caller', async () => {
    const res = await POST(req({ fact: '  Prefere   WhatsApp  ' }), p({ id: CT_A }));
    expect(res.status).toBe(201);
    const row = h.tables.ai_contact_memories.at(-1)!;
    expect(row).toMatchObject({
      account_id: 'acc-a',
      contact_id: CT_A,
      fact: 'Prefere WhatsApp',
      status: 'active',
      source: 'manual',
      created_by: 'user-a',
      approved_by: 'user-a',
    });
  });

  it('refuses viewers, sensitive data, duplicates, foreign and anonymized contacts', async () => {
    h.role = 'viewer';
    expect((await POST(req({ fact: 'x' }), p({ id: CT_A }))).status).toBe(403);
    h.role = 'agent';
    const sens = await POST(req({ fact: 'CPF 123.456.789-09' }), p({ id: CT_A }));
    expect(sens.status).toBe(400);
    expect((await sens.json()).error).toBe(MEMORY_ERRORS.sensitive);
    expect((await POST(req({ fact: 'prefere entrega a tarde!' }), p({ id: CT_A }))).status).toBe(409);
    expect((await POST(req({ fact: 'x' }), p({ id: CT_B }))).status).toBe(404);
    expect((await POST(req({ fact: 'x' }), p({ id: CT_ANON }))).status).toBe(403);
    expect(h.tables.ai_contact_memories).toHaveLength(4);
  });
});

describe('PATCH / DELETE /api/contacts/:id/ai/memories/:memoryId (approval flow)', () => {
  it('approve stamps approved_by; reject clears it; edit makes it active', async () => {
    let res = await PATCH(req({ status: 'active' }, 'PATCH'), p({ id: CT_A, memoryId: M_PROPOSED }));
    expect(res.status).toBe(200);
    expect(mem(M_PROPOSED)).toMatchObject({ status: 'active', approved_by: 'user-a' });

    res = await PATCH(req({ status: 'rejected' }, 'PATCH'), p({ id: CT_A, memoryId: M_PROPOSED }));
    expect(mem(M_PROPOSED)).toMatchObject({ status: 'rejected', approved_by: null });

    res = await PATCH(req({ fact: 'Trabalha com eventos corporativos' }, 'PATCH'), p({ id: CT_A, memoryId: M_PROPOSED }));
    expect(res.status).toBe(200);
    expect(mem(M_PROPOSED)).toMatchObject({ fact: 'Trabalha com eventos corporativos', status: 'active', approved_by: 'user-a' });
  });

  it('validates input and scopes to the account and the contact', async () => {
    expect((await PATCH(req({ status: 'maybe' }, 'PATCH'), p({ id: CT_A, memoryId: M_PROPOSED }))).status).toBe(400);
    expect((await PATCH(req({}, 'PATCH'), p({ id: CT_A, memoryId: M_PROPOSED }))).status).toBe(400);
    expect((await PATCH(req({ fact: 'senha 123' }, 'PATCH'), p({ id: CT_A, memoryId: M_PROPOSED }))).status).toBe(400);
    // Account B's fact, through B's contact id or through our contact id.
    expect((await PATCH(req({ status: 'active' }, 'PATCH'), p({ id: CT_B, memoryId: M_B }))).status).toBe(404);
    expect((await PATCH(req({ status: 'rejected' }, 'PATCH'), p({ id: CT_A, memoryId: M_B }))).status).toBe(404);
    expect((await DELETE(req(undefined, 'DELETE'), p({ id: CT_A, memoryId: M_B }))).status).toBe(404);
    expect(mem(M_B)).toMatchObject({ status: 'active', fact: 'SEGREDO B' });
    h.role = 'viewer';
    expect((await PATCH(req({ status: 'active' }, 'PATCH'), p({ id: CT_A, memoryId: M_PROPOSED }))).status).toBe(403);
    expect((await DELETE(req(undefined, 'DELETE'), p({ id: CT_A, memoryId: M_ACTIVE }))).status).toBe(403);
    expect(mem(M_PROPOSED)?.status).toBe('proposed');
  });

  it('agent deletes a fact', async () => {
    expect((await DELETE(req(undefined, 'DELETE'), p({ id: CT_A, memoryId: M_ACTIVE }))).status).toBe(200);
    expect(mem(M_ACTIVE)).toBeUndefined();
  });
});

describe('POST /api/conversations/:id/ai/memory (extract)', () => {
  it('one model call; new facts stored as proposed after validation, filter and dedupe', async () => {
    h.runModelCall.mockResolvedValue({
      text: JSON.stringify({
        fatos: [
          'Trabalha com buffet de eventos', // new
          'Prefere entrega a tarde', // duplicate of active (accent-insensitive)
          'Gosta de bolo de cenoura', // was rejected → not proposed again
          'CPF 123.456.789-09', // sensitive
          'x'.repeat(400), // too long
          'Trabalha com buffet de eventos!', // duplicate in batch
        ],
      }),
    });
    const res = await EXTRACT(req({}), p({ id: CONV_A }));
    expect(res.status).toBe(200);
    const { created } = await res.json();
    expect(created.map((m: Row) => m.fact)).toEqual(['Trabalha com buffet de eventos']);
    expect(h.tables.ai_contact_memories.at(-1)).toMatchObject({
      account_id: 'acc-a',
      contact_id: CT_A,
      conversation_id: CONV_A,
      status: 'proposed',
      source: 'ai',
      created_by: 'user-a',
    });

    expect(h.runModelCall).toHaveBeenCalledOnce();
    const input = h.runModelCall.mock.calls[0][0];
    expect(input).toMatchObject({ accountId: 'acc-a', conversationId: CONV_A, feature: 'memory_extract' });
    expect(input.prompt).toContain('Sou do buffet Sol');
    expect(input.prompt).toContain('{"fato":"Prefere entrega à tarde"}');
    expect(input.prompt).not.toContain('bolo de cenoura');
    expect(input.prompt).not.toContain('SEGREDO B');
  });

  it('invalid model output → 502 and nothing stored', async () => {
    h.runModelCall.mockResolvedValue({ text: 'Claro! Aqui estão os fatos: ...' });
    const res = await EXTRACT(req({}), p({ id: CONV_A }));
    expect(res.status).toBe(502);
    expect((await res.json()).code).toBe('invalid_response');
    expect(h.tables.ai_contact_memories).toHaveLength(4);
  });

  it('gatekeeping: viewer 403, foreign conversation 404, AI off 409, budget 402', async () => {
    h.role = 'viewer';
    expect((await EXTRACT(req({}), p({ id: CONV_A }))).status).toBe(403);
    h.role = 'agent';
    expect((await EXTRACT(req({}), p({ id: CONV_B }))).status).toBe(404);
    h.runModelCall.mockRejectedValueOnce(new AiError('budget_exceeded'));
    expect((await EXTRACT(req({}), p({ id: CONV_A }))).status).toBe(402);
    h.tables.ai_settings[0].enabled = false;
    expect((await EXTRACT(req({}), p({ id: CONV_A }))).status).toBe(409);
    expect(h.runModelCall).toHaveBeenCalledOnce();
  });
});

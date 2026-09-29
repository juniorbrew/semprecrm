import { beforeEach, describe, expect, it, vi } from 'vitest';

// ------------------------------------------------------------
// /api/ai/knowledge, /api/ai/knowledge/:id, /api/ai/knowledge/search
//
// Session context and a tiny PostgREST-ish client are mocked; what is
// tested is gatekeeping (role, module, account isolation) and what the
// routes hand to the database.
// ------------------------------------------------------------

type Row = Record<string, unknown>;

const h = vi.hoisted(() => ({
  role: 'admin' as string | null,
  aiModule: true,
  items: [] as Row[],
  rpc: vi.fn(),
  audits: [] as Row[],
}));

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }));
vi.mock('@/lib/automations/admin-client', () => ({ supabaseAdmin: () => ({}) }));
vi.mock('@/lib/audit-server', () => ({ audit: vi.fn(async (e: Row) => h.audits.push(e)) }));

function makeSupabase() {
  return {
    rpc: h.rpc,
    from() {
      let rows = [...h.items];
      let op: 'select' | 'update' | 'delete' = 'select';
      let patch: Row = {};
      const b = {
        select: () => b,
        order: () => b,
        eq: (col: string, val: unknown) => {
          rows = rows.filter((r) => r[col] === val);
          return b;
        },
        update: (p: Row) => {
          op = 'update';
          patch = p;
          return b;
        },
        delete: () => {
          op = 'delete';
          return b;
        },
        maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
        then: (resolve: (v: { data: Row[]; error: null; count: number }) => unknown) => {
          if (op === 'update') for (const r of rows) Object.assign(r, patch);
          if (op === 'delete') h.items = h.items.filter((r) => !rows.includes(r));
          return resolve({ data: rows, error: null, count: rows.length });
        },
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
    requireRole: vi.fn(async (min: 'admin') => {
      if (!h.role) throw new actual.UnauthorizedError();
      if (!hasMinRole(h.role as 'admin', min)) throw new actual.ForbiddenError('Insufficient role');
      return { supabase: makeSupabase(), userId: 'u-a', accountId: 'acc-a', role: h.role, account: { id: 'acc-a', name: 'A' } };
    }),
    requireModule: vi.fn(async () => {
      if (!h.aiModule) throw new actual.ModuleNotIncludedError('ai');
      return {};
    }),
  };
});

import { __resetRateLimitForTests } from '@/lib/rate-limit';
import { KB_EXTRACT_ERRORS } from '@/lib/ai/knowledge-extract';
import { GET as LIST, POST as CREATE } from './route';
import { DELETE, GET as READ, PATCH } from './[id]/route';
import { POST as SEARCH } from './search/route';

const ITEM_A = '11111111-1111-4111-8111-111111111111';
const ITEM_B = '22222222-2222-4222-8222-222222222222';
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const json = (body: unknown, method = 'POST') => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});
const url = 'http://localhost/api/ai/knowledge';

beforeEach(() => {
  __resetRateLimitForTests();
  h.role = 'admin';
  h.aiModule = true;
  h.audits = [];
  h.items = [
    { id: ITEM_A, account_id: 'acc-a', kind: 'text', title: 'Horário', content: 'Abrimos às 7h', enabled: true },
    { id: ITEM_B, account_id: 'acc-b', kind: 'text', title: 'SEGREDO B', content: 'x', enabled: true },
  ];
  h.rpc.mockReset();
  h.rpc.mockImplementation(async (fn: string) =>
    fn === 'ai_knowledge_save_item'
      ? { data: ITEM_A, error: null }
      : { data: [{ chunk_id: 'c', item_id: ITEM_A, title: 'Horário', kind: 'text', content: 'Abrimos às 7h', rank: '0.3' }], error: null },
  );
});

describe('auth', () => {
  it('agents and viewers get 403 on every route; no session 401', async () => {
    for (const role of ['agent', 'viewer']) {
      h.role = role;
      expect((await LIST()).status).toBe(403);
      expect((await CREATE(new Request(url, json({ kind: 'text', title: 't', content: 'c' })))).status).toBe(403);
      expect((await READ(new Request(url), params(ITEM_A))).status).toBe(403);
      expect((await PATCH(new Request(url, json({ enabled: false }, 'PATCH')), params(ITEM_A))).status).toBe(403);
      expect((await DELETE(new Request(url), params(ITEM_A))).status).toBe(403);
      expect((await SEARCH(new Request(url, json({ query: 'oi' })))).status).toBe(403);
    }
    expect(h.rpc).not.toHaveBeenCalled();
    h.role = null;
    expect((await LIST()).status).toBe(401);
  });

  it('403 module_not_included without the AI module', async () => {
    h.aiModule = false;
    const res = await LIST();
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('module_not_included');
  });
});

describe('items', () => {
  it('lists only the session account', async () => {
    const body = await (await LIST()).json();
    expect(body.items.map((i: Row) => i.id)).toEqual([ITEM_A]);
  });

  it('creates a FAQ with one Pergunta/Resposta chunk in the session account', async () => {
    const res = await CREATE(
      new Request(url, json({ kind: 'faq', question: 'Entregam?', content: 'Sim, no centro.', account_id: 'acc-b' })),
    );
    expect(res.status).toBe(201);
    const [fn, args] = h.rpc.mock.calls[0];
    expect(fn).toBe('ai_knowledge_save_item');
    expect(args).toMatchObject({
      p_account_id: 'acc-a',
      p_item_id: null,
      p_kind: 'faq',
      p_title: 'Entregam?',
      p_question: 'Entregam?',
      p_chunks: ['Pergunta: Entregam?\nResposta: Sim, no centro.'],
    });
    expect(h.audits[0]).toMatchObject({ action: 'ai.knowledge_changed', metadata: { op: 'created', kind: 'faq' } });
    expect(JSON.stringify(h.audits)).not.toContain('Sim, no centro');
  });

  it('rejects bad kinds and invalid bodies', async () => {
    expect((await CREATE(new Request(url, json({ kind: 'file', title: 't', content: 'c' })))).status).toBe(400);
    expect((await CREATE(new Request(url, json({ kind: 'text', title: '', content: 'c' })))).status).toBe(400);
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it('uploads a text file and stores only the extracted text', async () => {
    const form = new FormData();
    form.set('file', new File(['Preço do pão: R$ 1,00'], 'tabela.txt', { type: 'text/plain' }));
    const res = await CREATE(new Request(url, { method: 'POST', body: form }));
    expect(res.status).toBe(201);
    expect(h.rpc.mock.calls[0][1]).toMatchObject({
      p_kind: 'file',
      p_title: 'tabela',
      p_content: 'Preço do pão: R$ 1,00',
      p_source_filename: 'tabela.txt',
    });
  });

  it('ignores a non-string title field and falls back when the filename has no stem', async () => {
    const form = new FormData();
    form.set('file', new File(['Horário: 7h às 19h'], '.txt', { type: 'text/plain' }));
    form.set('title', new File(['x'], 'title.bin'));
    expect((await CREATE(new Request(url, { method: 'POST', body: form }))).status).toBe(201);
    expect(h.rpc.mock.calls[0][1]).toMatchObject({ p_title: 'Arquivo', p_source_filename: '.txt' });
    expect(JSON.stringify(h.rpc.mock.calls[0][1])).not.toContain('[object File]');
  });

  it('413 by Content-Length before reading the body', async () => {
    const req = new Request(url, {
      method: 'POST',
      headers: { 'content-type': 'multipart/form-data; boundary=x', 'content-length': String(50 * 1024 * 1024) },
      body: 'irrelevant',
    });
    const spy = vi.spyOn(req, 'formData');
    const res = await CREATE(req);
    expect(res.status).toBe(413);
    expect((await res.json()).error).toBe(KB_EXTRACT_ERRORS.size);
    expect(spy).not.toHaveBeenCalled();
  });

  it('a FAQ with a 600-char question saves with a 200-char title', async () => {
    const question = `${'Qual é o prazo de entrega '.repeat(23)}?`;
    expect((await CREATE(new Request(url, json({ kind: 'faq', title: '', question, content: 'Dois dias.' })))).status).toBe(201);
    const args = h.rpc.mock.calls[0][1];
    expect(args.p_question).toBe(question.replace(/\s+/g, ' ').trim());
    expect(args.p_title.length).toBeLessThanOrEqual(200);
  });

  it('rejects an unreadable upload with a clear message', async () => {
    const form = new FormData();
    form.set('file', new File(['x'], 'foto.png'));
    const res = await CREATE(new Request(url, { method: 'POST', body: form }));
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe(KB_EXTRACT_ERRORS.type);
  });

  it("404 for another account's item on read/edit/delete", async () => {
    expect((await READ(new Request(url), params(ITEM_B))).status).toBe(404);
    expect((await PATCH(new Request(url, json({ enabled: false }, 'PATCH')), params(ITEM_B))).status).toBe(404);
    expect((await DELETE(new Request(url), params(ITEM_B))).status).toBe(404);
    expect((await READ(new Request(url), params('nope'))).status).toBe(404);
    expect(h.items.find((i) => i.id === ITEM_B)?.enabled).toBe(true);
  });

  it('toggles, edits (re-chunks) and deletes own items', async () => {
    expect((await PATCH(new Request(url, json({ enabled: false }, 'PATCH')), params(ITEM_A))).status).toBe(200);
    expect(h.items.find((i) => i.id === ITEM_A)?.enabled).toBe(false);

    const res = await PATCH(new Request(url, json({ title: 'Horário', content: 'Abrimos às 8h' }, 'PATCH')), params(ITEM_A));
    expect(res.status).toBe(200);
    expect(h.rpc.mock.calls[0][1]).toMatchObject({ p_item_id: ITEM_A, p_kind: 'text', p_chunks: ['Abrimos às 8h'] });

    expect((await DELETE(new Request(url), params(ITEM_A))).status).toBe(200);
    expect(h.items.map((i) => i.id)).toEqual([ITEM_B]);
  });
});

describe('search', () => {
  it('searches the session account and returns capped hits', async () => {
    const res = await SEARCH(new Request(url, json({ query: ' que horas abrem? ', accountId: 'acc-b' })));
    expect(res.status).toBe(200);
    expect(h.rpc).toHaveBeenCalledWith('ai_knowledge_search', { p_account_id: 'acc-a', p_query: 'que horas abrem?', p_limit: 5 });
    const body = await res.json();
    expect(body.hits[0]).toMatchObject({ title: 'Horário', rank: 0.3 });
  });

  it('400 for an empty query', async () => {
    expect((await SEARCH(new Request(url, json({ query: '  ' })))).status).toBe(400);
  });
});

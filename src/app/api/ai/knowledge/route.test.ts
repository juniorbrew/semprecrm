import { beforeEach, describe, expect, it, vi } from 'vitest';

// ------------------------------------------------------------
// /api/ai/knowledge, /api/ai/knowledge/:id, /api/ai/knowledge/search,
// /api/ai/knowledge/:id/versions[/:version/restore] (087)
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
  versions: [] as Row[],
  rpc: vi.fn(),
  audits: [] as Row[],
}));

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }));
vi.mock('@/lib/automations/admin-client', () => ({ supabaseAdmin: () => ({}) }));
vi.mock('@/lib/audit-server', () => ({ audit: vi.fn(async (e: Row) => h.audits.push(e)) }));

function makeSupabase() {
  return {
    rpc: h.rpc,
    from(table: string) {
      let rows = [...(table === 'ai_knowledge_item_versions' ? h.versions : h.items)];
      let op: 'select' | 'update' | 'delete' = 'select';
      let patch: Row = {};
      const b = {
        select: () => b,
        order: () => b,
        limit: () => b,
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
import { GET as VERSIONS } from './[id]/versions/route';
import { POST as RESTORE } from './[id]/versions/[version]/restore/route';

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
  h.versions = [
    { item_id: ITEM_A, account_id: 'acc-a', version_no: 1, kind: 'text', title: 'Horário', question: null, content: 'Abrimos às 6h', category: 'Loja' },
    { item_id: ITEM_A, account_id: 'acc-a', version_no: 2, kind: 'text', title: 'Horário', question: null, content: 'Abrimos às 7h', category: null },
    { item_id: ITEM_B, account_id: 'acc-b', version_no: 1, kind: 'text', title: 'SEGREDO B', question: null, content: 'x', category: null },
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

describe('categories and versions (087)', () => {
  const vparams = (id: string, version: string) => ({ params: Promise.resolve({ id, version }) });

  it('create and edit hand the category to the save RPC; too long is a 400', async () => {
    expect((await CREATE(new Request(url, json({ kind: 'text', title: 't', content: 'c', category: ' Loja ' })))).status).toBe(201);
    expect(h.rpc.mock.calls[0][1]).toMatchObject({ p_category: 'Loja' });
    expect((await PATCH(new Request(url, json({ title: 't', content: 'c', category: '' }, 'PATCH')), params(ITEM_A))).status).toBe(200);
    expect(h.rpc.mock.calls[1][1]).toMatchObject({ p_item_id: ITEM_A, p_category: null });
    expect((await CREATE(new Request(url, json({ kind: 'text', title: 't', content: 'c', category: 'x'.repeat(61) })))).status).toBe(400);
    expect(h.rpc).toHaveBeenCalledTimes(2);
  });

  it('an edit without `category` keeps the current one', async () => {
    h.items[0].category = 'Loja';
    expect((await PATCH(new Request(url, json({ title: 't', content: 'c' }, 'PATCH')), params(ITEM_A))).status).toBe(200);
    expect(h.rpc.mock.calls[0][1]).toMatchObject({ p_item_id: ITEM_A, p_category: 'Loja' });
  });

  it('lists the versions of an own item only', async () => {
    const res = await VERSIONS(new Request(url), params(ITEM_A));
    expect(res.status).toBe(200);
    expect((await res.json()).versions.map((v: Row) => v.version_no).sort()).toEqual([1, 2]);
    expect((await VERSIONS(new Request(url), params(ITEM_B))).status).toBe(404);
    expect((await VERSIONS(new Request(url), params('nope'))).status).toBe(404);
  });

  it('restore re-saves the old version as a new one, marked restored_from, and audits it', async () => {
    const res = await RESTORE(new Request(url, { method: 'POST' }), vparams(ITEM_A, '1'));
    expect(res.status).toBe(200);
    const [fn, args] = h.rpc.mock.calls[0];
    expect(fn).toBe('ai_knowledge_save_item');
    expect(args).toMatchObject({
      p_account_id: 'acc-a',
      p_item_id: ITEM_A,
      p_kind: 'text',
      p_content: 'Abrimos às 6h',
      p_chunks: ['Abrimos às 6h'],
      p_category: 'Loja',
      p_restored_from: 1,
    });
    expect(h.audits[0]).toMatchObject({ metadata: { op: 'restored', version: 1 } });
    expect(JSON.stringify(h.audits)).not.toContain('Abrimos');
  });

  it("restore: another account's version, a missing one or a bad number is a 404 without saving", async () => {
    expect((await RESTORE(new Request(url, { method: 'POST' }), vparams(ITEM_B, '1'))).status).toBe(404);
    expect((await RESTORE(new Request(url, { method: 'POST' }), vparams(ITEM_A, '9'))).status).toBe(404);
    for (const bad of ['0', '-1', '1.5', 'abc']) {
      expect((await RESTORE(new Request(url, { method: 'POST' }), vparams(ITEM_A, bad))).status).toBe(404);
    }
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it('agents get 403 on history and restore', async () => {
    h.role = 'agent';
    expect((await VERSIONS(new Request(url), params(ITEM_A))).status).toBe(403);
    expect((await RESTORE(new Request(url, { method: 'POST' }), vparams(ITEM_A, '1'))).status).toBe(403);
    expect(h.rpc).not.toHaveBeenCalled();
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


describe('publication', () => {
  it('publishes the reviewed version using the session tenant and audits only metadata', async () => {
    const res = await PATCH(new Request(url, json({ publish_version: 2 }, 'PATCH')), params(ITEM_A));
    expect(res.status).toBe(200);
    expect(h.rpc).toHaveBeenCalledWith('ai_knowledge_publish_item', {
      p_account_id: 'acc-a', p_item_id: ITEM_A, p_version: 2,
    });
    expect(h.audits[0].metadata).toEqual({ op: 'published', kind: 'text', version: 2 });
  });
  it('rejects malformed or mixed publication requests', async () => {
    for (const body of [{ publish_version: 0 }, { publish_version: '2' }, { publish_version: 1.5 }, { publish_version: 2147483648 },
      { publish_version: 2, content: 'unreviewed' }]) {
      expect((await PATCH(new Request(url, json(body, 'PATCH')), params(ITEM_A))).status).toBe(400);
    }
    expect(h.rpc).not.toHaveBeenCalled();
  });
  it('rejects stale review without an audit success', async () => {
    h.rpc.mockResolvedValue({ data: null, error: { code: '40001' } });
    expect((await PATCH(new Request(url, json({ publish_version: 1 }, 'PATCH')), params(ITEM_A))).status).toBe(409);
    expect(h.audits).toEqual([]);
  });
  it('does not publish another tenant item or without the AI plan/admin role', async () => {
    expect((await PATCH(new Request(url, json({ publish_version: 1 }, 'PATCH')), params(ITEM_B))).status).toBe(404);
    h.role = 'agent';
    expect((await PATCH(new Request(url, json({ publish_version: 1 }, 'PATCH')), params(ITEM_A))).status).toBe(403);
    h.role = 'admin'; h.aiModule = false;
    expect((await PATCH(new Request(url, json({ publish_version: 1 }, 'PATCH')), params(ITEM_A))).status).toBe(403);
    expect(h.rpc).not.toHaveBeenCalled();
  });
  it('reports a publish failure without changing the item or auditing success', async () => {
    h.rpc.mockResolvedValue({ data: null, error: { code: 'XX000' } });
    expect((await PATCH(new Request(url, json({ publish_version: 2 }, 'PATCH')), params(ITEM_A))).status).toBe(500);
    expect(h.audits).toEqual([]);
  });
});

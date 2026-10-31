import { beforeEach, describe, expect, it, vi } from 'vitest';

import { fakeSupabase, makeFakeDb, type FakeDb } from '@/lib/ai/fake-supabase.test-helper';

// ------------------------------------------------------------
// POST /api/conversations/:id/ai/deal-summary/apply
//
// Session + entitlements are mocked, the database is an in-memory fake.
// What is tested: gatekeeping, account / contact / open-deal isolation,
// server-side re-validation, that ONLY the sent items are applied, and
// that stage / task / value / note go through the app's own paths
// (stage move = UPDATE + conversation event).
// ------------------------------------------------------------

const CONV = '11111111-1111-4111-8111-111111111111';
const CONV_B = '22222222-2222-4222-8222-222222222222';
const DEAL = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const DEAL_CLOSED = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const DEAL_OTHER_CONTACT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const DEAL_ACC_B = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

const h = vi.hoisted(() => ({
  db: null as unknown as FakeDb,
  role: 'agent' as string | null,
  readOnly: false,
  modules: { pipelines: true, tasks: true } as Record<string, boolean>,
}));

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }));
vi.mock('@/lib/auth/account', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/account')>();
  const { hasMinRole } = await import('@/lib/auth/roles');
  const { fakeSupabase: fake } = await import('@/lib/ai/fake-supabase.test-helper');
  return {
    ...actual,
    requireRole: vi.fn(async (min: 'agent') => {
      if (!h.role) throw new actual.UnauthorizedError();
      if (!hasMinRole(h.role as 'agent', min)) throw new actual.ForbiddenError('Insufficient role');
      return {
        supabase: fake(h.db),
        userId: 'user-a',
        accountId: 'acc-a',
        role: h.role,
        account: { id: 'acc-a', name: 'Padaria Sol' },
      };
    }),
    requireWritable: vi.fn(async (ctx: unknown) => {
      if (h.readOnly) throw new actual.ReadOnlyError('trial_ended' as never);
      return ctx;
    }),
    getEntitlements: vi.fn(async () => ({ modules: h.modules, blocked: false })),
  };
});

import { POST } from './route';

const call = (body: unknown, id = CONV) =>
  POST(new Request('http://x/apply', { method: 'POST', body: JSON.stringify(body) }), {
    params: Promise.resolve({ id }),
  });

const deal = (over: Record<string, unknown>) => ({
  account_id: 'acc-a',
  contact_id: 'c1',
  title: 'Plano anual',
  value: 1000,
  expected_close_date: null,
  notes: 'nota antiga',
  stage_id: 's-new',
  pipeline_id: 'p1',
  status: 'open',
  ...over,
});

function seed() {
  h.db = makeFakeDb({
    conversations: [
      { id: CONV, account_id: 'acc-a', channel: 'official', contact_id: 'c1', contact: { name: 'Maria', anonymized_at: null } },
      { id: CONV_B, account_id: 'acc-b', channel: 'official', contact_id: 'cb', contact: { name: 'Zé', anonymized_at: null } },
    ],
    deals: [
      deal({ id: DEAL }),
      deal({ id: DEAL_CLOSED, status: 'won' }),
      deal({ id: DEAL_OTHER_CONTACT, contact_id: 'c2' }),
      deal({ id: DEAL_ACC_B, account_id: 'acc-b', contact_id: 'cb' }),
    ],
    pipeline_stages: [
      { id: 's-new', pipeline_id: 'p1', name: 'Novo', position: 0, color: '#111' },
      { id: 's-prop', pipeline_id: 'p1', name: 'Proposta', position: 1, color: '#222' },
      { id: 's-foreign', pipeline_id: 'p2', name: 'Outro funil', position: 0, color: '#333' },
    ],
    task_statuses: [{ id: 'ts1', account_id: 'acc-a', name: 'A fazer', kind: 'open', is_default: true, position: 0 }],
    tasks: [],
    conversation_events: [],
  });
}

beforeEach(() => {
  h.role = 'agent';
  h.readOnly = false;
  h.modules = { pipelines: true, tasks: true };
  seed();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

const dealRow = () => h.db.tables.deals.find((d) => d.id === DEAL)!;
const FUTURE = '2099-01-01';

describe('gatekeeping', () => {
  it('401 without session, 403 for a viewer', async () => {
    h.role = null;
    expect((await call({ deal_id: DEAL })).status).toBe(401);
    h.role = 'viewer';
    expect((await call({ deal_id: DEAL })).status).toBe(403);
  });

  it('402 for a read-only account and nothing is written', async () => {
    h.readOnly = true;
    const res = await call({ deal_id: DEAL, value: 5 });
    expect(res.status).toBe(402);
    expect(h.db.writes).toEqual([]);
  });

  it('400 without a valid deal_id', async () => {
    expect((await call({})).status).toBe(400);
    expect((await call({ deal_id: 'nope' })).status).toBe(400);
    expect((await call(null)).status).toBe(400);
  });

  it('404 for a conversation of another account', async () => {
    expect((await call({ deal_id: DEAL_ACC_B }, CONV_B)).status).toBe(404);
    expect(h.db.writes).toEqual([]);
  });

  it.each([
    ['a deal of another contact', DEAL_OTHER_CONTACT],
    ['a deal of another account', DEAL_ACC_B],
    ['a closed deal', DEAL_CLOSED],
    ['an unknown deal', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'],
  ])('404 for %s, nothing written', async (_l, id) => {
    expect((await call({ deal_id: id, stage_id: 's-prop', value: 1 })).status).toBe(404);
    expect(h.db.writes).toEqual([]);
  });

  it('403 for an anonymized contact', async () => {
    (h.db.tables.conversations[0].contact as Record<string, unknown>).anonymized_at = '2026-01-01';
    expect((await call({ deal_id: DEAL, value: 1 })).status).toBe(403);
    expect(h.db.writes).toEqual([]);
  });
});

describe('applying', () => {
  it('applies only what was sent (value alone leaves stage, date, notes and tasks untouched)', async () => {
    const res = await call({ deal_id: DEAL, value: 2500.5 });
    expect(await res.json()).toEqual({ results: { value: 'applied' } });
    expect(dealRow()).toMatchObject({ value: 2500.5, stage_id: 's-new', notes: 'nota antiga', expected_close_date: null });
    expect(h.db.tables.tasks).toHaveLength(0);
    expect(h.db.tables.conversation_events).toHaveLength(0);
  });

  it('moves the stage like the panel does: UPDATE stage_id + conversation event', async () => {
    const res = await call({ deal_id: DEAL, stage_id: 's-prop' });
    expect(await res.json()).toEqual({ results: { stageId: 'applied' } });
    expect(dealRow().stage_id).toBe('s-prop');
    expect(h.db.tables.conversation_events).toEqual([
      expect.objectContaining({
        account_id: 'acc-a',
        conversation_id: CONV,
        actor_user_id: 'user-a',
        event_type: 'deal_stage_changed',
        payload: expect.objectContaining({ deal_id: DEAL, from_stage_name: 'Novo', to_stage_name: 'Proposta' }),
      }),
    ]);
  });

  it('refuses a stage of another pipeline and keeps the deal where it was', async () => {
    const res = await call({ deal_id: DEAL, stage_id: 's-foreign', value: 10 });
    expect(await res.json()).toEqual({ results: { stageId: 'invalid', value: 'applied' } });
    expect(dealRow().stage_id).toBe('s-new');
    expect(h.db.tables.conversation_events).toHaveLength(0);
  });

  it('refuses a move to the stage it is already in', async () => {
    expect((await (await call({ deal_id: DEAL, stage_id: 's-new' })).json()).results).toEqual({ stageId: 'invalid' });
  });

  it('creates the task linked to the deal, conversation and contact, assigned to the caller (a due date beyond a year is dropped, the task stays)', async () => {
    const res = await call({ deal_id: DEAL, task: { title: 'Enviar proposta', due_date: FUTURE } });
    expect(await res.json()).toEqual({ results: { task: 'applied' } });
    expect(h.db.tables.tasks[0]).toMatchObject({
      account_id: 'acc-a',
      created_by: 'user-a',
      assignee_user_id: 'user-a',
      title: 'Enviar proposta',
      deal_id: DEAL,
      contact_id: 'c1',
      conversation_id: CONV,
      status_id: 'ts1',
      due_at: null,
    });
  });

  it('keeps a valid task due date as noon -03:00', async () => {
    const soon = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);
    await call({ deal_id: DEAL, task: { title: 'Ligar', due_date: soon } });
    expect(h.db.tables.tasks[0].due_at).toBe(`${soon}T12:00:00-03:00`);
  });

  it('appends the summary to the existing notes with a dated header', async () => {
    const res = await call({ deal_id: DEAL, note: 'O que o cliente quer: plano' });
    expect(await res.json()).toEqual({ results: { note: 'applied' } });
    const notes = String(dealRow().notes);
    expect(notes.startsWith('nota antiga\n\nResumo da IA — ')).toBe(true);
    expect(notes.endsWith('\nO que o cliente quer: plano')).toBe(true);
  });

  it('value, close date and note go in ONE update with updated_at', async () => {
    const date = new Date(Date.now() + 20 * 86_400_000).toISOString().slice(0, 10);
    await call({ deal_id: DEAL, value: 10, expected_close_date: date, note: 'x' });
    const updates = h.db.writes.filter((w) => w.table === 'deals');
    expect(updates).toHaveLength(1);
    expect(updates[0].row).toEqual(
      expect.objectContaining({ value: 10, expected_close_date: date, notes: expect.any(String), updated_at: expect.any(String) }),
    );
    expect(updates[0].match).toMatchObject({ id: DEAL, account_id: 'acc-a' });
  });

  it('reports too_long when the summary does not fit the 2000-char notes, and changes nothing', async () => {
    dealRow().notes = 'a'.repeat(1900);
    const res = await call({ deal_id: DEAL, note: 'b'.repeat(500) });
    expect(await res.json()).toEqual({ results: { note: 'too_long' } });
    expect(dealRow().notes).toBe('a'.repeat(1900));
  });

  it.each([
    ['negative value', { value: -3 }, 'value'],
    ['absurd value', { value: 1e15 }, 'value'],
    ['value as text', { value: '10' }, 'value'],
    ['past date', { expected_close_date: '2020-01-01' }, 'closeDate'],
    ['far date', { expected_close_date: '2099-01-01' }, 'closeDate'],
    ['empty task title', { task: { title: ' ', due_date: null } }, 'task'],
    ['long task title', { task: { title: 'x'.repeat(200) } }, 'task'],
    ['huge note', { note: 'x'.repeat(5000) }, 'note'],
  ])('rejects %s without writing', async (_l, body, key) => {
    const res = await call({ deal_id: DEAL, ...body });
    expect((await res.json()).results).toEqual({ [key]: 'invalid' });
    expect(h.db.writes).toEqual([]);
  });

  it('one failing item does not undo or block the others', async () => {
    h.db.fail.tasks = ['insert'];
    const res = await call({ deal_id: DEAL, stage_id: 's-prop', task: { title: 'Ligar' }, value: 7 });
    expect((await res.json()).results).toEqual({ value: 'applied', stageId: 'applied', task: 'failed' });
    expect(dealRow()).toMatchObject({ value: 7, stage_id: 's-prop' });
  });

  it('a failed deal update marks value/date/note failed and no success is reported', async () => {
    h.db.fail.deals = ['update'];
    const res = await call({ deal_id: DEAL, value: 7, note: 'x' });
    expect((await res.json()).results).toEqual({ value: 'failed', note: 'failed' });
  });

  it('plan modules: no Pipelines blocks deal items, no Tasks blocks the task', async () => {
    h.modules = { pipelines: false, tasks: false };
    const res = await call({ deal_id: DEAL, stage_id: 's-prop', value: 5, task: { title: 'Ligar' }, note: 'x' });
    expect((await res.json()).results).toEqual({
      value: 'not_in_plan',
      note: 'not_in_plan',
      stageId: 'not_in_plan',
      task: 'not_in_plan',
    });
    expect(h.db.writes).toEqual([]);
  });

  it('every query is scoped to the session account (no body field can change it)', async () => {
    await call({ deal_id: DEAL, account_id: 'acc-b', value: 5, stage_id: 's-prop' });
    for (const w of h.db.writes.filter((x) => x.table === 'deals' && x.match.account_id !== undefined)) {
      expect(w.match.account_id).toBe('acc-a');
    }
    expect(h.db.writes.some((w) => w.row.account_id === 'acc-b')).toBe(false);
  });
});

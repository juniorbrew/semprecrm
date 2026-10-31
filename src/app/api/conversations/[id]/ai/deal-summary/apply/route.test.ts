import { beforeEach, describe, expect, it, vi } from 'vitest';

import { replaceSummaryNote, normalizeTitle } from '@/lib/ai/deal-summary-apply';
import { FakeDb } from '@/lib/whatsapp/fake-supabase.testkit';

// ------------------------------------------------------------
// POST /api/conversations/:id/ai/deal-summary/apply
//
// Session + entitlements are mocked, the database is the shared
// in-memory fake. What is tested: gatekeeping, account / contact /
// open-deal isolation, server-side re-validation, that ONLY the sent
// items are applied, stale / already / duplicate handling, and that
// stage / task / value / note go through the app's own paths (stage move
// = UPDATE + conversation event).
// ------------------------------------------------------------

const CONV = '11111111-1111-4111-8111-111111111111';
const CONV_B = '22222222-2222-4222-8222-222222222222';
const DEAL = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const DEAL_CLOSED = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const DEAL_OTHER_CONTACT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const DEAL_ACC_B = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const UPDATED = '2026-10-01T00:00:00.000Z';

const h = vi.hoisted(() => ({
  db: null as unknown as InstanceType<typeof import('@/lib/whatsapp/fake-supabase.testkit').FakeDb>,
  role: 'agent' as string | null,
  readOnly: false,
  user: 'user-a',
  modules: { pipelines: true, tasks: true } as Record<string, boolean>,
}));

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }));
vi.mock('@/lib/auth/account', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/account')>();
  const { hasMinRole } = await import('@/lib/auth/roles');
  return {
    ...actual,
    requireRole: vi.fn(async (min: 'agent') => {
      if (!h.role) throw new actual.UnauthorizedError();
      if (!hasMinRole(h.role as 'agent', min)) throw new actual.ForbiddenError('Insufficient role');
      return {
        supabase: h.db.client(),
        userId: h.user,
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

/** A body the way the card builds it: what it showed + what is checked. */
const send = (extra: Record<string, unknown>, expected: Record<string, unknown> = {}) =>
  call({
    deal_id: DEAL,
    expected: { stage_id: 's-new', value: 1000, expected_close_date: null, ...expected },
    ...extra,
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
  updated_at: UPDATED,
  ...over,
});

function seed() {
  h.db = new FakeDb();
  h.db.seed('conversations', [
    { id: CONV, account_id: 'acc-a', channel: 'official', contact_id: 'c1', contact: { name: 'Maria', anonymized_at: null } },
    { id: CONV_B, account_id: 'acc-b', channel: 'official', contact_id: 'cb', contact: { name: 'Zé', anonymized_at: null } },
  ]);
  h.db.seed('deals', [
    deal({ id: DEAL }),
    deal({ id: DEAL_CLOSED, status: 'won' }),
    deal({ id: DEAL_OTHER_CONTACT, contact_id: 'c2' }),
    deal({ id: DEAL_ACC_B, account_id: 'acc-b', contact_id: 'cb' }),
  ]);
  h.db.seed('pipeline_stages', [
    { id: 's-new', pipeline_id: 'p1', name: 'Novo', position: 0, color: '#111' },
    { id: 's-prop', pipeline_id: 'p1', name: 'Proposta', position: 1, color: '#222' },
    { id: 's-foreign', pipeline_id: 'p2', name: 'Outro funil', position: 0, color: '#333' },
  ]);
  h.db.seed('task_statuses', [{ id: 'ts1', account_id: 'acc-a', name: 'A fazer', kind: 'open', is_default: true, position: 0 }]);
}

beforeEach(() => {
  h.role = 'agent';
  h.readOnly = false;
  h.user = `user-${Math.random()}`;
  h.modules = { pipelines: true, tasks: true };
  seed();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

const dealRow = () => h.db.table('deals').find((d) => d.id === DEAL)!;
const results = async (res: Response) => (await res.json()).results;
const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

describe('gatekeeping', () => {
  it('401 without session, 403 for a viewer', async () => {
    h.role = null;
    expect((await call({ deal_id: DEAL })).status).toBe(401);
    h.role = 'viewer';
    expect((await call({ deal_id: DEAL })).status).toBe(403);
  });

  it('402 for a read-only account and nothing is written', async () => {
    h.readOnly = true;
    const res = await send({ value: 5 });
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
    ['an unknown deal', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'],
  ])('404 for %s, nothing written', async (_l, id) => {
    expect((await call({ deal_id: id, stage_id: 's-prop', value: 1 })).status).toBe(404);
    expect(h.db.writes).toEqual([]);
  });

  it('409 deal_not_open when the deal was closed since the summary, nothing written', async () => {
    const res = await call({ deal_id: DEAL_CLOSED, value: 1 });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('deal_not_open');
    expect(h.db.writes).toEqual([]);
  });

  it('403 for an anonymized contact', async () => {
    (h.db.table('conversations')[0].contact as Record<string, unknown>).anonymized_at = '2026-01-01';
    expect((await send({ value: 1 })).status).toBe(403);
    expect(h.db.writes).toEqual([]);
  });

  it('429 after 20 applies in a minute from the same user', async () => {
    for (let i = 0; i < 20; i++) expect((await call({})).status).toBe(400);
    expect((await call({})).status).toBe(429);
  });
});

describe('applying', () => {
  it('applies only what was sent (value alone leaves stage, date, notes and tasks untouched)', async () => {
    expect(await results(await send({ value: 2500.5 }))).toEqual({ value: 'applied' });
    expect(dealRow()).toMatchObject({ value: 2500.5, stage_id: 's-new', notes: 'nota antiga', expected_close_date: null });
    expect(h.db.table('tasks')).toHaveLength(0);
    expect(h.db.table('conversation_events')).toHaveLength(0);
  });

  it('moves the stage like the panel does: UPDATE stage_id + conversation event', async () => {
    expect(await results(await send({ stage_id: 's-prop' }))).toEqual({ stageId: 'applied' });
    expect(dealRow().stage_id).toBe('s-prop');
    expect(h.db.table('conversation_events')).toEqual([
      expect.objectContaining({
        account_id: 'acc-a',
        conversation_id: CONV,
        actor_user_id: h.user,
        event_type: 'deal_stage_changed',
        payload: expect.objectContaining({ deal_id: DEAL, from_stage_name: 'Novo', to_stage_name: 'Proposta' }),
      }),
    ]);
  });

  it('refuses a stage of another pipeline and keeps the deal where it was', async () => {
    expect(await results(await send({ stage_id: 's-foreign', value: 10 }))).toEqual({ stageId: 'invalid', value: 'applied' });
    expect(dealRow().stage_id).toBe('s-new');
    expect(h.db.table('conversation_events')).toHaveLength(0);
  });

  it('a proposed stage equal to the current one is "already", not invalid, and writes nothing', async () => {
    expect(await results(await send({ stage_id: 's-new' }))).toEqual({ stageId: 'already' });
    expect(h.db.writes).toEqual([]);
  });

  it('creates the task linked to the deal, conversation and contact, assigned to the caller (a due date beyond a year is dropped, the task stays)', async () => {
    expect(await results(await send({ task: { title: 'Enviar proposta', due_date: '2099-01-01' } }))).toEqual({ task: 'applied' });
    expect(h.db.table('tasks')[0]).toMatchObject({
      account_id: 'acc-a',
      created_by: h.user,
      assignee_user_id: h.user,
      title: 'Enviar proposta',
      deal_id: DEAL,
      contact_id: 'c1',
      conversation_id: CONV,
      status_id: 'ts1',
      due_at: null,
    });
  });

  it('keeps a valid task due date as noon -03:00', async () => {
    const soon = inDays(5);
    await send({ task: { title: 'Ligar', due_date: soon } });
    expect(h.db.table('tasks')[0].due_at).toBe(`${soon}T12:00:00-03:00`);
  });

  it('value, close date and note go in ONE guarded update (status open + updated_at read at the start)', async () => {
    const date = inDays(20);
    await send({ value: 10, expected_close_date: date, note: 'x' });
    const updates = h.db.writes.filter((w) => w.table === 'deals');
    expect(updates).toHaveLength(1);
    expect(updates[0].row).toEqual(
      expect.objectContaining({ value: 10, expected_close_date: date, notes: expect.any(String), updated_at: expect.any(String) }),
    );
    expect(updates[0].match).toMatchObject({ id: DEAL, account_id: 'acc-a', status: 'open', updated_at: UPDATED });
  });

  it('reports too_long when the summary does not fit the 2000-char notes, and changes nothing', async () => {
    dealRow().notes = 'a'.repeat(1900);
    expect(await results(await send({ note: 'b'.repeat(500) }))).toEqual({ note: 'too_long' });
    expect(dealRow().notes).toBe('a'.repeat(1900));
  });

  it.each([
    ['negative value', { value: -3 }, 'value'],
    ['absurd value', { value: 1e15 }, 'value'],
    ['past date', { expected_close_date: '2020-01-01' }, 'closeDate'],
    ['far date', { expected_close_date: '2099-01-01' }, 'closeDate'],
    ['empty task title', { task: { title: ' ', due_date: null } }, 'task'],
    ['long task title', { task: { title: 'x'.repeat(200) } }, 'task'],
    ['task with a link', { task: { title: 'Abrir www.golpe.com' } }, 'task'],
    ['task with a pix key', { task: { title: 'Pagar via pix' } }, 'task'],
    ['huge note', { note: 'x'.repeat(5000) }, 'note'],
  ])('rejects %s without writing', async (_l, body, key) => {
    expect(await results(await send(body))).toEqual({ [key]: 'invalid' });
    expect(h.db.writes).toEqual([]);
  });

  it('one failing item does not undo or block the others', async () => {
    h.db.failures.tasks = ['insert'];
    expect(await results(await send({ stage_id: 's-prop', task: { title: 'Ligar' }, value: 7 }))).toEqual({
      value: 'applied',
      stageId: 'applied',
      task: 'failed',
    });
    expect(dealRow()).toMatchObject({ value: 7, stage_id: 's-prop' });
  });

  it('a failed deal update marks value/note failed and no success is reported', async () => {
    h.db.failures.deals = ['update'];
    expect(await results(await send({ value: 7, note: 'x' }))).toEqual({ value: 'failed', note: 'failed' });
  });

  it('plan modules: no Pipelines blocks deal items, no Tasks blocks the task', async () => {
    h.modules = { pipelines: false, tasks: false };
    expect(await results(await send({ stage_id: 's-prop', value: 5, task: { title: 'Ligar' }, note: 'x' }))).toEqual({
      value: 'not_in_plan',
      note: 'not_in_plan',
      stageId: 'not_in_plan',
      task: 'not_in_plan',
    });
    expect(h.db.writes).toEqual([]);
  });

  it('every query is scoped to the session account (no body field can change it)', async () => {
    await send({ account_id: 'acc-b', value: 5, stage_id: 's-prop' });
    for (const w of h.db.writes.filter((x) => x.table === 'deals' && x.match.account_id !== undefined)) {
      expect(w.match.account_id).toBe('acc-a');
    }
    expect(h.db.writes.some((w) => w.row.account_id === 'acc-b')).toBe(false);
  });
});

describe('the deal changed since the summary was generated', () => {
  it('stage: expected stage differs from the current one -> stale, not moved', async () => {
    expect(await results(await send({ stage_id: 's-prop' }, { stage_id: 's-old' }))).toEqual({ stageId: 'stale' });
    expect(dealRow().stage_id).toBe('s-new');
    expect(h.db.writes).toEqual([]);
  });

  it('value and close date: expected differs -> stale, nothing overwritten', async () => {
    dealRow().value = 1200; // somebody edited it meanwhile
    dealRow().expected_close_date = '2026-12-24';
    const res = await send({ value: 2500, expected_close_date: inDays(30) });
    expect(await results(res)).toEqual({ value: 'stale', closeDate: 'stale' });
    expect(dealRow()).toMatchObject({ value: 1200, expected_close_date: '2026-12-24' });
    expect(h.db.writes).toEqual([]);
  });

  it('a body without "expected" is treated as stale for stage, value and date (never blind overwrite)', async () => {
    const res = await call({ deal_id: DEAL, stage_id: 's-prop', value: 5, expected_close_date: inDays(9) });
    expect(await results(res)).toEqual({ stageId: 'stale', value: 'stale', closeDate: 'stale' });
    expect(h.db.writes).toEqual([]);
  });

  it('a concurrent edit between the read and the update (updated_at moved) -> stale, row untouched', async () => {
    const row = dealRow();
    // The stages are read after the deal and before the UPDATE: touching the deal from there simulates the race.
    h.db.table('pipeline_stages')[0] = Object.defineProperty(
      { id: 's-new', pipeline_id: 'p1', position: 0, color: '#111' },
      'name',
      { enumerable: true, get: () => ((row.updated_at = '2026-10-02T00:00:00.000Z'), 'Novo') },
    );
    expect(await results(await send({ value: 99, note: 'x' }))).toEqual({ value: 'stale', note: 'stale' });
    expect(row).toMatchObject({ value: 1000, notes: 'nota antiga' });
  });

  it('the deal was closed between the read and the update -> stale', async () => {
    const row = dealRow();
    h.db.table('pipeline_stages')[0] = Object.defineProperty(
      { id: 's-new', pipeline_id: 'p1', position: 0, color: '#111' },
      'name',
      { enumerable: true, get: () => ((row.status = 'won'), 'Novo') },
    );
    expect(await results(await send({ value: 99 }))).toEqual({ value: 'stale' });
    expect(row.value).toBe(1000);
  });
});

describe('duplicate tasks', () => {
  const existing = (over: Record<string, unknown>) => ({ account_id: 'acc-a', deal_id: DEAL, title: 'Enviar proposta', completed_at: null, ...over });

  it('skips a task when an open one with the same normalized title exists for the deal', async () => {
    h.db.seed('tasks', [existing({ title: '  enviar PROPOSTA! ' })]);
    expect(await results(await send({ task: { title: 'Enviar proposta' } }))).toEqual({ task: 'duplicate' });
    expect(h.db.table('tasks')).toHaveLength(1);
  });

  it('ignores accents and punctuation when comparing', async () => {
    h.db.seed('tasks', [existing({ title: 'Ligar: confirmação' })]);
    expect(await results(await send({ task: { title: 'ligar confirmacao' } }))).toEqual({ task: 'duplicate' });
  });

  it('a COMPLETED task with the same title does not block a new one', async () => {
    h.db.seed('tasks', [existing({ completed_at: '2026-10-20T00:00:00Z' })]);
    expect(await results(await send({ task: { title: 'Enviar proposta' } }))).toEqual({ task: 'applied' });
    expect(h.db.table('tasks')).toHaveLength(2);
  });

  it('the same title on another deal or account does not count', async () => {
    h.db.seed('tasks', [existing({ deal_id: 'other-deal' }), existing({ account_id: 'acc-b' })]);
    expect(await results(await send({ task: { title: 'Enviar proposta' } }))).toEqual({ task: 'applied' });
  });
});

describe('the summary note', () => {
  it('REPLACES the previous AI block and keeps everything the user wrote', async () => {
    dealRow().notes = 'nota antiga\n\nResumo da IA — 01/10/2026\nO que o cliente quer: velho\nSituação: velha\n\nOutra nota do usuário';
    expect(await results(await send({ note: 'O que o cliente quer: novo' }))).toEqual({ note: 'applied' });
    const notes = String(dealRow().notes);
    expect(notes.startsWith('nota antiga\n\nOutra nota do usuário\n\nResumo da IA — ')).toBe(true);
    expect(notes.endsWith('\nO que o cliente quer: novo')).toBe(true);
    expect(notes).not.toContain('velho');
    expect(notes.match(/Resumo da IA/g)).toHaveLength(1);
  });

  it('repeating it many times never grows the notes', async () => {
    let size = 0;
    for (let i = 0; i < 6; i++) {
      const res = await call({
        deal_id: DEAL,
        note: 'O que o cliente quer: ' + 'x'.repeat(300),
        expected: { stage_id: 's-new', value: 1000, expected_close_date: null },
      });
      expect(await results(res)).toEqual({ note: 'applied' });
      dealRow().updated_at = UPDATED; // the fake keeps the guard value fixed between rounds
      size = String(dealRow().notes).length;
    }
    expect(size).toBeLessThan(400);
  });
});

describe('replaceSummaryNote / normalizeTitle', () => {
  it('adds the block when there is none, or when the notes are empty', () => {
    expect(replaceSummaryNote(null, 'N', '2026-10-31')).toBe('Resumo da IA — 31/10/2026\nN');
    expect(replaceSummaryNote('abc', 'N', '2026-10-31')).toBe('abc\n\nResumo da IA — 31/10/2026\nN');
  });
  it('replaces a block at the start, middle and end', () => {
    const old = 'Resumo da IA — 01/10/2026\nvelho';
    expect(replaceSummaryNote(old, 'N', '2026-10-31')).toBe('Resumo da IA — 31/10/2026\nN');
    expect(replaceSummaryNote(`${old}\n\nfim`, 'N', '2026-10-31')).toBe('fim\n\nResumo da IA — 31/10/2026\nN');
    expect(replaceSummaryNote(`ini\n\n${old}\n\nfim`, 'N', '2026-10-31')).toBe('ini\n\nfim\n\nResumo da IA — 31/10/2026\nN');
  });
  it('a user line that merely mentions the phrase is kept', () => {
    expect(replaceSummaryNote('Fiz um Resumo da IA ontem', 'N', '2026-10-31')).toContain('Fiz um Resumo da IA ontem');
  });
  it('normalizeTitle', () => {
    expect(normalizeTitle('  Ligar: CONFIRMAÇÃO!! ')).toBe('ligar confirmacao');
  });
});

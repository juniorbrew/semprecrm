import { describe, expect, it, vi } from 'vitest';

import type { AgentAction } from './skills';
import { BOOK_MESSAGES, bookedWhen, executeActions, type ActionStatus, type BookResult, type MoveDealResult, type SkillGateway } from './skills-exec';

function gateway(over: Partial<SkillGateway> = {}) {
  const calls: string[] = [];
  const finished: [number, ActionStatus, string][] = [];
  const gw: SkillGateway = {
    claim: vi.fn(async () => true),
    finish: vi.fn(async (seq, status, detail) => {
      finished.push([seq, status, detail]);
    }),
    addNote: vi.fn(async (t) => void calls.push(`note:${t}`)),
    findTag: vi.fn(async (n) => (n.toLowerCase() === 'interessado' ? { id: 't1', name: 'Interessado' } : null)),
    addTag: vi.fn(async (id) => void calls.push(`tag:${id}`)),
    createTask: vi.fn(async (i) => {
      calls.push(`task:${i.title}`);
      return 'task-1';
    }),
    moveDeal: vi.fn(async (): Promise<MoveDealResult> => 'moved'),
    book: vi.fn(
      async (): Promise<BookResult> => ({
        ok: true,
        service: 'Corte',
        professional: 'Ana',
        startsAt: '2026-10-28T17:00:00.000Z',
        timezone: 'America/Sao_Paulo',
      }),
    ),
    ...over,
  };
  return { gw, calls, finished };
}

const note: AgentAction = { skill: 'internal_note', text: 'Quer proposta' };
const tag: AgentAction = { skill: 'add_tag', tag: 'interessado' };

describe('executeActions', () => {
  it('runs each action and records its outcome', async () => {
    const { gw, calls, finished } = gateway();
    const res = await executeActions([note, tag, { skill: 'create_task', title: 'Ligar', description: null, dueInHours: 24 }], gw);
    expect(calls).toEqual(['note:Quer proposta', 'tag:t1', 'task:Ligar']);
    expect(res.map((r) => r.status)).toEqual(['ok', 'ok', 'ok']);
    expect(finished.map((f) => f[0])).toEqual([0, 1, 2]);
  });

  it('never repeats an action already recorded for the job (retried reply)', async () => {
    const { gw, calls } = gateway({ claim: vi.fn(async (seq: number) => seq !== 0) });
    const res = await executeActions([note, tag], gw);
    expect(calls).toEqual(['tag:t1']);
    expect(res.map((r) => r.seq)).toEqual([1]);
  });

  it('skips (never creates) a tag that does not exist', async () => {
    const { gw, calls } = gateway();
    const res = await executeActions([{ skill: 'add_tag', tag: 'Inexistente' }], gw);
    expect(calls).toEqual([]);
    expect(res[0]).toMatchObject({ status: 'skipped', detail: 'Etiqueta não encontrada' });
  });

  it('records a failing action as error and still runs the next one', async () => {
    const { gw, calls, finished } = gateway({ addNote: vi.fn(async () => { throw new Error('boom'); }) });
    const res = await executeActions([note, tag], gw);
    expect(res.map((r) => r.status)).toEqual(['error', 'ok']);
    expect(finished[0]).toEqual([0, 'error', 'boom']);
    expect(calls).toEqual(['tag:t1']);
  });

  it('maps deal-move results to ok / skipped', async () => {
    for (const [result, status] of [['moved', 'ok'], ['same', 'skipped'], ['no_deal', 'skipped'], ['no_stage', 'skipped']] as const) {
      const { gw } = gateway({ moveDeal: vi.fn(async () => result) });
      const res = await executeActions([{ skill: 'move_deal_stage', stage: 'Proposta' }], gw);
      expect(res[0].status).toBe(status);
    }
  });

  it('survives a ledger failure without throwing (the reply must still go out)', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { gw } = gateway({ claim: vi.fn(async () => { throw new Error('db down'); }) });
    await expect(executeActions([note], gw)).resolves.toEqual([]);
    spy.mockRestore();
  });
});

describe('book_appointment', () => {
  const book: AgentAction = { skill: 'book_appointment', service: 'corte', date: '2026-10-28', time: '14:00', professional: null };

  it('formats the local date and time of the booking', () => {
    expect(bookedWhen('2026-10-28T17:00:00.000Z', 'America/Sao_Paulo')).toBe('quarta-feira, 28/10 às 14:00');
  });

  it('a booking confirms to the customer only after it is reserved, by the server', async () => {
    const { gw } = gateway();
    const [r] = await executeActions([book], gw);
    expect(gw.book).toHaveBeenCalledWith({ service: 'corte', date: '2026-10-28', time: '14:00', professional: null });
    expect(r).toMatchObject({ status: 'ok', customerMessage: 'Pronto! Seu horário está reservado: Corte, quarta-feira, 28/10 às 14:00, com Ana.' });
  });

  it('a taken or invalid time tells the customer to pick another; nothing is confirmed', async () => {
    const taken = gateway({ book: vi.fn(async (): Promise<BookResult> => ({ ok: false, reason: 'taken' })) });
    expect((await executeActions([book], taken.gw))[0]).toMatchObject({ status: 'skipped', customerMessage: BOOK_MESSAGES.taken });
    const bad = gateway({ book: vi.fn(async (): Promise<BookResult> => ({ ok: false, reason: 'no_service' })) });
    expect((await executeActions([book], bad.gw))[0]).toMatchObject({ status: 'skipped', customerMessage: BOOK_MESSAGES.unavailable });
  });

  it('a crash while booking still tells the customer the team will confirm', async () => {
    const { gw } = gateway({ book: vi.fn(async () => Promise.reject(new Error('db down'))) });
    expect((await executeActions([book], gw))[0]).toMatchObject({ status: 'error', customerMessage: BOOK_MESSAGES.failed });
  });

  it('a retried job re-asks the booking (same job = same appointment) and still confirms it; the ledger is not rewritten', async () => {
    const { gw, finished } = gateway({ claim: vi.fn(async () => false) });
    const [r] = await executeActions([note, book], gw);
    expect(gw.addNote).not.toHaveBeenCalled();
    expect(gw.book).toHaveBeenCalledWith({ service: 'corte', date: '2026-10-28', time: '14:00', professional: null });
    expect(r).toMatchObject({ seq: 1, status: 'ok', customerMessage: expect.stringContaining('Pronto!') });
    expect(finished).toEqual([]);
  });

  it('booked but the ledger write failed: the customer gets the real confirmation', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { gw } = gateway({ finish: vi.fn(async () => { throw new Error('db down'); }) });
    const [r] = await executeActions([book], gw);
    expect(r).toMatchObject({ status: 'ok', customerMessage: expect.stringContaining('Pronto!') });
    spy.mockRestore();
  });

  it('other actions never produce customer messages', async () => {
    const { gw } = gateway();
    const res = await executeActions([note, tag], gw);
    expect(res.every((r) => r.customerMessage === undefined)).toBe(true);
  });
});

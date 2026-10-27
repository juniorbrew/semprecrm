import { describe, expect, it } from 'vitest';

import { bookForAi, loadAgendaOffer, spread } from './ai';
import { ACC, MON_10, NOW, setup } from './fake-agenda.test-helper';
import { getAvailability, getAvailabilityForServices } from './service';

const input = (over: Record<string, unknown> = {}) => ({
  accountId: ACC,
  contactId: 'c1',
  conversationId: 'conv-1',
  idempotencyKey: 'ai:job-1:0',
  service: 'Corte',
  date: '2026-10-26',
  time: '10:00',
  professional: null,
  now: NOW,
  ...over,
});

describe('spread', () => {
  it('keeps a short list and spreads a long one from first to last', () => {
    expect(spread([1, 2, 3], 5)).toEqual([1, 2, 3]);
    expect(spread([0, 1, 2, 3, 4, 5, 6, 7, 8], 3)).toEqual([0, 4, 8]);
    expect(spread([1, 2, 3], 1)).toEqual([1]);
  });
});

describe('getAvailabilityForServices', () => {
  it('gives every active service the same slots as asking for it alone', async () => {
    const { db } = setup();
    const all = await getAvailabilityForServices(db, { accountId: ACC, from: '2026-10-26', to: '2026-10-27', now: NOW });
    const one = await getAvailability(db, { accountId: ACC, serviceId: 's1', from: '2026-10-26', to: '2026-10-27', now: NOW });
    expect(all.services.map((s) => s.service.id)).toEqual(['s1']); // s2 is inactive
    expect(all.services[0].slots).toEqual(one.slots);
  });
});

describe('loadAgendaOffer', () => {
  it('offers active services with their professionals and local start times', async () => {
    const { db } = setup();
    const offer = await loadAgendaOffer(db as never, ACC, NOW);
    expect(offer.timezone).toBe('America/Sao_Paulo');
    expect(offer.services).toHaveLength(1);
    const [corte] = offer.services;
    expect(corte).toMatchObject({ name: 'Corte', minutes: 60, professionals: ['Ana', 'Bia'] });
    // Only Mondays have hours: the first free day is Mon 26/10, 09:00..12:00.
    expect(corte.days[0].date).toBe('2026-10-26');
    expect(corte.days[0].times).toEqual(['09:00', '09:30', '10:00', '10:30', '11:00', '11:30', '12:00']);
  });

  it('a busy time is not offered', async () => {
    const { db } = setup();
    for (const professional of ['Ana', 'Bia']) await bookForAi(db as never, input({ professional, idempotencyKey: professional }));
    const offer = await loadAgendaOffer(db as never, ACC, NOW);
    expect(offer.services[0].days[0].times).not.toContain('10:00');
  });
});

describe('bookForAi', () => {
  it('books by name and local time, as the AI, with the job key', async () => {
    const { db, rpcCalls } = setup();
    const res = await bookForAi(db as never, input({ service: '  CORTE ', professional: 'ana' }));
    expect(res).toEqual({ ok: true, service: 'Corte', professional: 'Ana', startsAt: MON_10, timezone: 'America/Sao_Paulo' });
    expect(rpcCalls[0].args).toMatchObject({
      p_account_id: ACC,
      p_service_id: 's1',
      p_resource_id: 'r1',
      p_contact_id: 'c1',
      p_starts_at: MON_10,
      p_source: 'ai',
      p_idempotency_key: 'ai:job-1:0',
    });
  });

  it('without a professional, any free one gets the booking', async () => {
    const { db } = setup();
    const res = await bookForAi(db as never, input());
    expect(res).toMatchObject({ ok: true, startsAt: MON_10 });
  });

  it('never books a service or professional that is not on offer', async () => {
    const { db, rpcCalls } = setup();
    expect(await bookForAi(db as never, input({ service: 'Manicure' }))).toEqual({ ok: false, reason: 'no_service' });
    expect(await bookForAi(db as never, input({ service: 'Off' }))).toEqual({ ok: false, reason: 'no_service' });
    expect(await bookForAi(db as never, input({ professional: 'Carla' }))).toEqual({ ok: false, reason: 'no_professional' });
    expect(await bookForAi(db as never, input({ professional: 'Sala' }))).toEqual({ ok: false, reason: 'no_professional' });
    expect(rpcCalls).toHaveLength(0);
  });

  it('a time someone else just took is reported as taken', async () => {
    const { db } = setup();
    expect(await bookForAi(db as never, input({ professional: 'Ana', idempotencyKey: 'a' }))).toMatchObject({ ok: true });
    expect(await bookForAi(db as never, input({ professional: 'Ana', idempotencyKey: 'b' }))).toEqual({ ok: false, reason: 'taken' });
  });

  it('a retry of the same job gets the appointment already made, even if the AI now asks another time', async () => {
    const { db, tables } = setup();
    const first = await bookForAi(db as never, input({ professional: 'Ana' }));
    const again = await bookForAi(db as never, input({ time: '11:00', professional: 'Bia' }));
    expect(again).toEqual(first);
    expect(tables.calendar_events).toHaveLength(1);
  });

  it('a retry after the appointment was cancelled confirms nothing', async () => {
    const { db, tables } = setup();
    await bookForAi(db as never, input());
    tables.calendar_events[0].status = 'cancelled';
    expect(await bookForAi(db as never, input())).toEqual({ ok: false, reason: 'unavailable' });
  });

  it('stops at the per-contact limit of future appointments (a person can still book)', async () => {
    const { db, rpcCalls } = setup((t) => {
      for (const [i, status] of ['scheduled', 'confirmed', 'scheduled', 'cancelled'].entries()) {
        t.calendar_events.push({ id: `old-${i}`, account_id: ACC, contact_id: 'c1', resource_id: 'r2', status, starts_at: `2026-11-0${i + 2}T13:00:00.000Z` });
      }
      t.calendar_events.push({ id: 'past', account_id: ACC, contact_id: 'c1', resource_id: 'r2', status: 'scheduled', starts_at: '2026-10-01T13:00:00.000Z' });
    });
    expect(await bookForAi(db as never, input())).toEqual({ ok: false, reason: 'limit' });
    expect(rpcCalls).toHaveLength(0);
  });

  it('a time outside the agenda rules is unavailable, not an error', async () => {
    const { db } = setup();
    expect(await bookForAi(db as never, input({ time: '15:00' }))).toEqual({ ok: false, reason: 'unavailable' });
    expect(await bookForAi(db as never, input({ time: '99:99' }))).toEqual({ ok: false, reason: 'unavailable' });
    expect(await bookForAi(db as never, input({ date: '2026-10-27' }))).toEqual({ ok: false, reason: 'unavailable' }); // Tuesday: closed
  });
});

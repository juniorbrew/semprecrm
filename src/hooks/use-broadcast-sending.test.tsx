// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { makeAudienceDb } from '@/lib/broadcasts/fake-db.test-helper';
import type { MessageTemplate } from '@/types';

const h = vi.hoisted(() => ({ db: null as unknown }));

vi.mock('@/lib/supabase/client', () => ({ createClient: () => h.db }));
vi.mock('@/hooks/use-auth', () => ({ useAuth: () => ({ accountId: 'acc-1' }) }));
vi.mock('@/hooks/use-language', async () => {
  const { translateLiteral } = await import('@/lib/i18n');
  return { useLanguage: () => ({ t: (k: string) => translateLiteral(k, 'pt-BR'), language: 'pt-BR' }) };
});
vi.mock('sonner', () => ({ toast: { warning: vi.fn(), error: vi.fn(), success: vi.fn() } }));

import { useBroadcastSending } from './use-broadcast-sending';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const template = { id: 't1', name: 'promo', language: 'pt_BR' } as MessageTemplate;

describe('useBroadcastSending — audience failures', () => {
  it.each([
    ['all', { type: 'all' as const, excludeTagIds: ['vip'] }],
    ['csv', { type: 'csv' as const, csvContacts: [{ phone: '+55 11 99999-0000' }], excludeTagIds: ['vip'] }],
  ])('%s: a failed excluded-tag lookup aborts before any write or send, with a pt-BR message', async (_, audience) => {
    const { db, log } = makeAudienceDb(
      { contacts: [{ id: 'c1', account_id: 'acc-1', phone: '+55 11 98888-0000', opted_out_at: null }] },
      ['contact_tags'],
    );
    h.db = db;
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const { result } = renderHook(() => useBroadcastSending());
    let error: unknown;
    await act(async () => {
      await result.current
        .createAndSendBroadcast({ name: 'x', template, audience, variables: {} })
        .catch((e: unknown) => (error = e));
    });

    expect((error as Error).message).toBe('Não foi possível carregar o público. Nada foi enviado.');
    expect(log.writes).toEqual([]); // no broadcast row, no contacts, no recipients
    expect(fetchSpy).not.toHaveBeenCalled(); // nothing sent
  });
});

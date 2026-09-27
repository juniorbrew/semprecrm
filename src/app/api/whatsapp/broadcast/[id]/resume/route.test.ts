import { beforeEach, describe, expect, it, vi } from 'vitest';

import { FakeDb } from '@/lib/whatsapp/fake-supabase.testkit';

const db = new FakeDb();

vi.mock('@/lib/auth/account', () => ({
  requireRole: vi.fn(async () => ({ supabase: db.client(), accountId: 'acct-1', userId: 'u-1' })),
  requireModule: vi.fn(async () => ({})),
  toErrorResponse: (e: unknown) => new Response(String(e), { status: 500 }),
}));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: () => ({ success: true }),
  rateLimitResponse: () => new Response(null, { status: 429 }),
  RATE_LIMITS: { broadcast: {} },
}));
vi.mock('@/lib/flows/admin-client', () => ({ supabaseAdmin: () => db.client() }));
const afterSpy = vi.fn();
vi.mock('next/server', async (orig) => ({
  ...(await orig<typeof import('next/server')>()),
  after: (fn: () => unknown) => afterSpy(fn),
}));

import { POST } from './route';

// Campanha anterior a esta versão (delivery_protocol NULL): o código antigo
// enviava antes de marcar a linha, então nada dela é enviado de novo — nem
// retomar, nem reenviar. "Encerrar" não envia: marca o que sobrou como
// incerto e fecha o status.

function chamar(scope: string) {
  return POST(new Request('http://x', { method: 'POST', body: JSON.stringify({ scope }) }), {
    params: Promise.resolve({ id: 'bc-1' }),
  });
}

function semear() {
  db.tables.clear();
  db.seed('broadcasts', [
    {
      id: 'bc-1',
      account_id: 'acct-1',
      status: 'sending',
      delivery_locked_at: null,
      delivery_protocol: null,
      updated_at: '2026-09-27T10:00:00.000Z',
      total_recipients: 3,
    },
  ]);
  db.seed('broadcast_recipients', [
    { id: 'r1', broadcast_id: 'bc-1', status: 'sent', claimed_at: null },
    { id: 'r2', broadcast_id: 'bc-1', status: 'pending', claimed_at: null },
    { id: 'r3', broadcast_id: 'bc-1', status: 'sending', claimed_at: null },
  ]);
}

describe('POST /api/whatsapp/broadcast/[id]/resume — campanha antiga', () => {
  beforeEach(() => {
    semear();
    afterSpy.mockReset();
  });

  it('retomar é recusado e nenhuma linha muda', async () => {
    const res = await chamar('pending');
    expect(res.status).toBe(409);
    expect(afterSpy).not.toHaveBeenCalled();
    expect(db.table('broadcast_recipients').map((r) => r.status)).toEqual(['sent', 'pending', 'sending']);
  });

  it('encerrar não envia: pendentes e enviando viram incertos e a campanha fecha', async () => {
    const res = await chamar('settle');
    expect(res.status).toBe(200);
    expect(afterSpy).not.toHaveBeenCalled();
    expect(db.table('broadcast_recipients').map((r) => r.status)).toEqual(['sent', 'uncertain', 'uncertain']);
    expect(db.table('broadcasts')[0].status).not.toBe('sending');
    expect(db.table('broadcasts')[0].delivery_locked_at ?? null).toBeNull();
  });
});

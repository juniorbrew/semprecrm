import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/whatsapp/encryption', () => ({ decrypt: (v: string) => `plain:${v}` }));
// The WhatsApp token is read with the service role: same fake database.
const admin = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/lib/flows/admin-client', () => ({ supabaseAdmin: () => admin.db }));

import {
  newLockToken,
  releaseDeliveryLock,
  renewDeliveryLock,
} from '@/lib/broadcast-delivery-lock';
import {
  claimBroadcastDelivery,
  planBroadcastResume,
  RESUME_MAX_PER_REQUEST,
} from './broadcast-resume';
import { FakeDb, type Row } from './fake-supabase.testkit';

// Ported from wacrm 3376991 (broadcast-resume.test.ts) and rewritten for
// the SempreCRM row-claim design, against an in-memory PostgREST
// stand-in with real filter semantics.

const ACCOUNT = 'acct-1';
const BC = 'bc-1';
const NOW = new Date('2026-09-27T12:00:00Z');

function seed(
  rows: Partial<Row>[],
  bc: Partial<Row> = {},
  bodyText = 'Olá {{1}}',
): FakeDb {
  const db = new FakeDb();
  admin.db = db.client();
  db.seed('broadcasts', [
    {
      id: BC,
      account_id: ACCOUNT,
      template_name: 'promo',
      template_language: 'pt_BR',
      header_media_url: null,
      template_variables: bodyText.includes('{{') ? { '1': { type: 'static', value: 'x' } } : {},
      status: 'sending',
      delivery_locked_at: null,
      delivery_protocol: 1,
      updated_at: '2026-09-27T10:00:00.000Z',
      ...bc,
    },
  ]);
  db.seed('whatsapp_config', [{ account_id: ACCOUNT, phone_number_id: 'pn-1', access_token: 'enc' }]);
  db.seed('message_templates', [
    { id: 't', user_id: 'u', account_id: ACCOUNT, name: 'promo', language: 'pt_BR', body_text: bodyText },
  ]);
  db.seed(
    'broadcast_recipients',
    rows.map((r, i) => ({
      id: `r${i}`,
      broadcast_id: BC,
      contact_id: `c${i}`,
      status: 'pending',
      template_params: ['x'],
      created_at: new Date(Date.UTC(2026, 8, 27, 9, 0, 0, i)).toISOString(),
      ...r,
    })),
  );
  return db;
}

describe('claimBroadcastDelivery', () => {
  it('claims an idle broadcast with my token', async () => {
    const db = seed([], { status: 'sent' });
    const token = newLockToken(NOW);
    expect(await claimBroadcastDelivery(db.client(), ACCOUNT, BC, token, NOW)).toBe(true);
    expect(db.table('broadcasts')[0].delivery_locked_at).toBe(token);
  });

  it('refuses while another pass holds a fresh lock', async () => {
    const db = seed([], { delivery_locked_at: '2026-09-27T11:55:00.000123Z' });
    expect(await claimBroadcastDelivery(db.client(), ACCOUNT, BC, newLockToken(NOW), NOW)).toBe(false);
  });

  it('takes over a stale lock (a pass that died)', async () => {
    const db = seed([], { delivery_locked_at: '2026-09-27T11:40:00.000123Z' });
    expect(await claimBroadcastDelivery(db.client(), ACCOUNT, BC, newLockToken(NOW), NOW)).toBe(true);
  });

  it('treats a lock-less "sending" campaign with recent activity as active', async () => {
    // A tab running a pre-051 bundle never set the lock, but its sends
    // keep bumping updated_at through the count trigger.
    const db = seed([], { status: 'sending', updated_at: '2026-09-27T11:58:00.000Z', delivery_protocol: null });
    expect(await claimBroadcastDelivery(db.client(), ACCOUNT, BC, newLockToken(NOW), NOW)).toBe(false);
  });

  it('does NOT apply the recent-activity rule to a new-protocol campaign (lock released = idle)', async () => {
    // A normal stop releases the lock while the campaign may still read
    // 'sending' with fresh counts — resuming must be allowed right away.
    const db = seed([], { status: 'sending', updated_at: '2026-09-27T11:59:00.000Z', delivery_protocol: 1 });
    expect(await claimBroadcastDelivery(db.client(), ACCOUNT, BC, newLockToken(NOW), NOW)).toBe(true);
  });

  it('claims a lock-less "sending" campaign that went quiet', async () => {
    const db = seed([], { status: 'sending', updated_at: '2026-09-27T11:00:00.000Z', delivery_protocol: 1 });
    expect(await claimBroadcastDelivery(db.client(), ACCOUNT, BC, newLockToken(NOW), NOW)).toBe(true);
  });

  it('never grants the lock to a legacy campaign (delivery_protocol NULL), even when quiet', async () => {
    const db = seed([], { status: 'sending', updated_at: '2026-09-27T11:00:00.000Z', delivery_protocol: null });
    expect(await claimBroadcastDelivery(db.client(), ACCOUNT, BC, newLockToken(NOW), NOW)).toBe(false);
    expect(db.table('broadcasts')[0].delivery_locked_at ?? null).toBeNull();
  });

  it('is scoped to the account', async () => {
    const db = seed([], { status: 'sent' });
    expect(await claimBroadcastDelivery(db.client(), 'acct-9', BC, newLockToken(NOW), NOW)).toBe(false);
  });
});

describe('lock ownership (stale tab)', () => {
  it('a stale tab cannot renew or release a lock a resume took over', async () => {
    const tabToken = newLockToken(new Date('2026-09-27T11:30:00Z'));
    const db = seed([], { delivery_locked_at: tabToken });
    const client = db.client();

    // The tab slept > 10 min; a resume pass takes the lock over.
    const resumeToken = newLockToken(NOW);
    expect(await claimBroadcastDelivery(client, ACCOUNT, BC, resumeToken, NOW)).toBe(true);

    // The tab wakes up: its renew fails (→ it must stop sending) …
    expect(await renewDeliveryLock(client, BC, tabToken)).toBeNull();
    // … and its release is a no-op.
    await releaseDeliveryLock(client, BC, tabToken);
    expect(db.table('broadcasts')[0].delivery_locked_at).toBe(resumeToken);

    // The owner can renew, and release.
    const next = await renewDeliveryLock(client, BC, resumeToken);
    expect(next).not.toBeNull();
    await releaseDeliveryLock(client, BC, next!);
    expect(db.table('broadcasts')[0].delivery_locked_at).toBeNull();
  });
});

describe('planBroadcastResume', () => {
  it('plans pending rows only for scope "pending"', async () => {
    const db = seed([{}, { status: 'failed' }, { status: 'uncertain' }, { status: 'sending', claimed_at: '2026-09-27T11:59:00Z' }]);
    const plan = await planBroadcastResume(db.client(), ACCOUNT, BC, 'pending', NOW);
    expect(plan.ids).toEqual(['r0']);
    expect(plan.from).toEqual(['pending']);
  });

  it('"failed" and "all" never include sending, uncertain or old-code failed rows', async () => {
    const rows = [
      {},
      { status: 'failed', claimed_at: '2026-09-27T10:00:00Z' },
      { status: 'uncertain' },
      { status: 'sending', claimed_at: '2026-09-27T11:59:00Z' },
      { status: 'failed' }, // written by the old code: claimed_at NULL
    ];
    const failed = await planBroadcastResume(seed(rows).client(), ACCOUNT, BC, 'failed', NOW);
    expect(failed.ids).toEqual(['r1']);
    expect(failed.remaining).toBe(0);
    const all = await planBroadcastResume(seed(rows).client(), ACCOUNT, BC, 'all', NOW);
    expect(all.ids).toEqual(['r0', 'r1']);
  });

  it('refuses "retry failed" when the only failures are old-code ones', async () => {
    const db = seed([{ status: 'failed' }, { status: 'sent' }]);
    await expect(planBroadcastResume(db.client(), ACCOUNT, BC, 'failed', NOW)).rejects.toMatchObject({
      code: 'nothing_to_resume',
    });
  });

  it('turns rows abandoned in "sending" into uncertain, not pending', async () => {
    const db = seed([{}, { status: 'sending', claimed_at: '2026-09-27T11:00:00Z' }]);
    const plan = await planBroadcastResume(db.client(), ACCOUNT, BC, 'all', NOW);
    expect(plan.ids).toEqual(['r0']);
    expect(db.table('broadcast_recipients')[1].status).toBe('uncertain');
  });

  it('counts more than 1000 pending exactly and caps one pass', async () => {
    const rows = Array.from({ length: RESUME_MAX_PER_REQUEST + 234 }, () => ({}));
    const plan = await planBroadcastResume(seed(rows).client(), ACCOUNT, BC, 'pending', NOW);
    expect(plan.ids).toHaveLength(RESUME_MAX_PER_REQUEST);
    expect(plan.remaining).toBe(234);
    expect(plan.ids[0]).toBe('r0'); // oldest first
  });

  // Legacy = created by the old browser-stamped code (delivery_protocol
  // NULL): its 'pending' rows may already have been sent.
  it.each(['pending', 'all'] as const)(
    'refuses scope "%s" for ANY legacy campaign, with or without template variables',
    async (scope) => {
      for (const body of ['Olá {{1}}', 'Promoção de hoje!']) {
        const db = seed([{ template_params: null }, {}], { delivery_protocol: null }, body);
        await expect(planBroadcastResume(db.client(), ACCOUNT, BC, scope, NOW)).rejects.toMatchObject({
          code: 'legacy_broadcast',
          status: 409,
        });
      }
    },
  );

  it('a legacy campaign has nothing retryable under "failed" (old failures lack claimed_at)', async () => {
    const db = seed([{ status: 'failed' }, {}], { delivery_protocol: null });
    await expect(planBroadcastResume(db.client(), ACCOUNT, BC, 'failed', NOW)).rejects.toMatchObject({
      code: 'nothing_to_resume',
    });
  });

  it('leaves legacy rows untouched when refusing', async () => {
    const db = seed([{}, { status: 'failed' }], { delivery_protocol: null });
    await planBroadcastResume(db.client(), ACCOUNT, BC, 'all', NOW).catch(() => undefined);
    expect(db.table('broadcast_recipients').map((r) => r.status)).toEqual(['pending', 'failed']);
  });

  it('refuses when there is nothing outstanding', async () => {
    const db = seed([{ status: 'sent' }, { status: 'uncertain' }]);
    await expect(planBroadcastResume(db.client(), ACCOUNT, BC, 'failed', NOW)).rejects.toMatchObject({
      code: 'nothing_to_resume',
    });
  });

  it('404s a broadcast from another account', async () => {
    const db = seed([{}]);
    await expect(planBroadcastResume(db.client(), 'acct-9', BC, 'pending', NOW)).rejects.toMatchObject({
      status: 404,
    });
  });

  it('refuses a malformed local template row', async () => {
    const db = seed([{}]);
    db.table('message_templates')[0].body_text = undefined;
    await expect(planBroadcastResume(db.client(), ACCOUNT, BC, 'pending', NOW)).rejects.toMatchObject({
      code: 'template_malformed',
    });
  });
});

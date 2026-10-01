import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/whatsapp/encryption', () => ({ decrypt: (v: string) => `plain:${v}` }));

const sendTemplateMessage = vi.fn();
vi.mock('@/lib/whatsapp/meta-api', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/whatsapp/meta-api')>();
  return {
    ...real,
    sendTemplateMessage: (...args: unknown[]) => sendTemplateMessage(...args),
  };
});

import { MetaSendError } from '@/lib/whatsapp/meta-api';
import { suppressionHash } from '@/lib/lgpd/suppression';
import { newLockToken } from '@/lib/broadcast-delivery-lock';
import {
  claimRecipientRows,
  deliverBroadcast,
  deliverRecipientIds,
  expireStaleSending,
  finalizeBroadcastStatus,
  loadDeliveryContext,
} from './broadcast-core';
import { FakeDb, type Row } from './fake-supabase.testkit';

// SempreCRM redesign of wacrm 3376991: every send path claims rows
// atomically and the server stamps outcomes. These tests run the real
// functions against an in-memory PostgREST stand-in with real filter
// semantics, so "claimed by someone else" really is invisible.

const ACCOUNT = 'acct-1';
const BC = 'bc-1';

function phoneOf(i: number): string {
  return `+55119${String(10000000 + i)}`; // valid E.164, distinct per i
}

function seed(n: number, opts: { lock?: string | null; bodyText?: string } = {}): FakeDb {
  const db = new FakeDb();
  db.seed('broadcasts', [
    {
      id: BC,
      account_id: ACCOUNT,
      template_name: 'promo',
      template_language: 'pt_BR',
      header_media_url: null,
      template_variables: { '1': { type: 'field', value: 'name' } },
      status: 'sending',
      delivery_locked_at: opts.lock ?? null,
      updated_at: '2026-09-27T11:00:00.000Z',
    },
  ]);
  db.seed('whatsapp_config', [{ account_id: ACCOUNT, phone_number_id: 'pn-1', access_token: 'enc' }]);
  db.seed('message_templates', [
    {
      id: 'tpl-1',
      user_id: 'u-1',
      account_id: ACCOUNT,
      name: 'promo',
      language: 'pt_BR',
      body_text: opts.bodyText ?? 'Olá {{1}}',
    },
  ]);
  const contacts: Row[] = [];
  const rows: Row[] = [];
  for (let i = 0; i < n; i++) {
    contacts.push({ id: `c${i}`, account_id: ACCOUNT, phone: phoneOf(i), opted_out_at: null });
    rows.push({
      id: `r${i}`,
      broadcast_id: BC,
      contact_id: `c${i}`,
      status: 'pending',
      template_params: [`Nome${i}`],
      created_at: new Date(Date.UTC(2026, 8, 27, 10, 0, i)).toISOString(),
    });
  }
  db.seed('contacts', contacts);
  db.seed('broadcast_recipients', rows);
  return db;
}

function rowStatuses(db: FakeDb): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of db.table('broadcast_recipients')) {
    out[r.status as string] = (out[r.status as string] ?? 0) + 1;
  }
  return out;
}

/** Number of sends per destination phone. */
function sendsPerPhone(): Map<string, number> {
  const m = new Map<string, number>();
  for (const [args] of sendTemplateMessage.mock.calls as [{ to: string }][]) {
    m.set(args.to, (m.get(args.to) ?? 0) + 1);
  }
  return m;
}

beforeEach(() => {
  sendTemplateMessage.mockReset();
  let n = 0;
  // Yield to the event loop inside every send so concurrent passes
  // genuinely interleave between claim, send and stamp.
  sendTemplateMessage.mockImplementation(async () => {
    await new Promise((r) => setTimeout(r, 0));
    n += 1;
    return { messageId: `wamid.${n}` };
  });
});

describe('row claim', () => {
  it('is exclusive: two passes claiming the same rows never share one', async () => {
    const db = seed(30);
    const ids = db.table('broadcast_recipients').map((r) => r.id as string);
    const [a, b] = await Promise.all([
      claimRecipientRows(db.client(), BC, ids, ['pending']),
      claimRecipientRows(db.client(), BC, ids, ['pending']),
    ]);
    const aIds = new Set(a.map((r) => r.id));
    expect(b.filter((r) => aIds.has(r.id))).toEqual([]);
    expect(a.length + b.length).toBe(30);
  });

  it('never claims sending / uncertain / sent rows', async () => {
    const db = seed(4);
    const rows = db.table('broadcast_recipients');
    rows[0].status = 'sending';
    rows[1].status = 'uncertain';
    rows[2].status = 'sent';
    const claimed = await claimRecipientRows(
      db.client(),
      BC,
      rows.map((r) => r.id as string),
      ['pending', 'failed'],
    );
    expect(claimed.map((r) => r.id)).toEqual(['r3']);
  });
});

describe('no row is sent twice', () => {
  it('wizard batches racing a resume pass over the same rows', async () => {
    const token = newLockToken();
    const db = seed(40, { lock: token });
    const client = db.client();
    const ctx = await loadDeliveryContext(client, ACCOUNT, BC);
    const ids = db.table('broadcast_recipients').map((r) => r.id as string);

    // Wizard: sequential batches of 10 (as /api/whatsapp/broadcast does).
    const wizard = (async () => {
      for (let i = 0; i < ids.length; i += 10) {
        await deliverRecipientIds(client, ctx, ids.slice(i, i + 10), ['pending']);
      }
    })();
    // Resume pass over everything, concurrently (lock shared on purpose:
    // this proves the ROW claim alone prevents duplicates).
    const resume = deliverBroadcast(client, ctx, { ids, from: ['pending'], lockToken: token });

    await Promise.all([wizard, resume]);

    const perPhone = sendsPerPhone();
    expect(perPhone.size).toBe(40);
    expect([...perPhone.values()].every((n) => n === 1)).toBe(true);
    expect(rowStatuses(db)).toEqual({ sent: 40 });
  });

  it('a reloaded tab replaying the same batch sends nothing again', async () => {
    const db = seed(10);
    const client = db.client();
    const ctx = await loadDeliveryContext(client, ACCOUNT, BC);
    const ids = db.table('broadcast_recipients').map((r) => r.id as string);

    const first = await deliverRecipientIds(client, ctx, ids, ['pending']);
    const replay = await deliverRecipientIds(client, ctx, ids, ['pending']);

    expect(first.every((r) => r.outcome === 'sent')).toBe(true);
    expect(replay.every((r) => r.outcome === 'skipped')).toBe(true);
    expect(sendTemplateMessage).toHaveBeenCalledTimes(10);
  });

  it('rows a dead pass left in "sending" become uncertain, never resent', async () => {
    const db = seed(3);
    const rows = db.table('broadcast_recipients');
    rows[0].status = 'sending';
    rows[0].claimed_at = '2026-09-27T10:00:00.000Z'; // long ago
    const client = db.client();

    const expired = await expireStaleSending(client, BC, new Date('2026-09-27T12:00:00Z'));
    expect(expired).toBe(1);
    expect(rows[0].status).toBe('uncertain');

    const ctx = await loadDeliveryContext(client, ACCOUNT, BC);
    await deliverRecipientIds(client, ctx, rows.map((r) => r.id as string), ['pending', 'failed']);
    expect(sendsPerPhone().has(phoneOf(0).replace('+', ''))).toBe(false);
    expect(sendTemplateMessage).toHaveBeenCalledTimes(2);
  });

  it('a fresh "sending" row is left alone by expiry', async () => {
    const db = seed(1);
    const row = db.table('broadcast_recipients')[0];
    row.status = 'sending';
    row.claimed_at = '2026-09-27T11:58:00.000Z';
    expect(await expireStaleSending(db.client(), BC, new Date('2026-09-27T12:00:00Z'))).toBe(0);
    expect(row.status).toBe('sending');
  });
});

describe('outcome classification', () => {
  it('an uncertain error (timeout/5xx/network) is stamped uncertain and not retried with another variant', async () => {
    sendTemplateMessage.mockReset();
    sendTemplateMessage.mockRejectedValue(new MetaSendError('timeout', { uncertain: true }));
    const db = seed(1);
    const client = db.client();
    const ctx = await loadDeliveryContext(client, ACCOUNT, BC);
    const [res] = await deliverRecipientIds(client, ctx, ['r0'], ['pending']);
    expect(res.outcome).toBe('uncertain');
    expect(sendTemplateMessage).toHaveBeenCalledTimes(1);
    expect(db.table('broadcast_recipients')[0].status).toBe('uncertain');
  });

  it('a confirmed Meta rejection (4xx) is stamped failed', async () => {
    sendTemplateMessage.mockReset();
    sendTemplateMessage.mockRejectedValue(
      new MetaSendError('(#132000) Number of parameters does not match', { uncertain: false, status: 400 }),
    );
    const db = seed(1);
    const client = db.client();
    const ctx = await loadDeliveryContext(client, ACCOUNT, BC);
    const [res] = await deliverRecipientIds(client, ctx, ['r0'], ['pending']);
    expect(res.outcome).toBe('failed');
    expect(db.table('broadcast_recipients')[0]).toMatchObject({
      status: 'failed',
      error_message: '(#132000) Number of parameters does not match',
    });
  });

  it('"retry failed" picks confirmed failures only — uncertain rows are never retried', async () => {
    const db = seed(3);
    const rows = db.table('broadcast_recipients');
    rows[0].status = 'failed';
    rows[0].claimed_at = '2026-09-27T10:00:00.000Z'; // failed under the claim protocol
    rows[1].status = 'uncertain';
    rows[2].status = 'sent';
    const client = db.client();
    const ctx = await loadDeliveryContext(client, ACCOUNT, BC);
    await deliverRecipientIds(client, ctx, rows.map((r) => r.id as string), ['failed']);
    expect(sendTemplateMessage).toHaveBeenCalledTimes(1);
    expect(rows.map((r) => r.status)).toEqual(['sent', 'uncertain', 'sent']);
  });

  it('never retries a "failed" row written by the old browser-stamped code (claimed_at NULL)', async () => {
    // The old wizard marked a whole batch failed on any error, even when
    // the server may already have sent it.
    const db = seed(2);
    const rows = db.table('broadcast_recipients');
    rows[0].status = 'failed'; // legacy: no claimed_at
    rows[1].status = 'failed';
    rows[1].claimed_at = '2026-09-27T10:00:00.000Z';
    const client = db.client();
    const ctx = await loadDeliveryContext(client, ACCOUNT, BC);
    const res = await deliverRecipientIds(client, ctx, ['r0', 'r1'], ['pending', 'failed']);
    expect(sendTemplateMessage).toHaveBeenCalledTimes(1);
    expect(res.find((r) => r.id === 'r0')?.outcome).toBe('skipped');
    expect(rows[0].status).toBe('failed');
  });

  it('finds an opt-out on another contact row even past the first 1000 opted-out contacts', async () => {
    const db = seed(1);
    const others: Row[] = Array.from({ length: 1200 }, (_, i) => ({
      id: `o${i}`,
      account_id: ACCOUNT,
      phone: `+4478${String(10000000 + i)}`,
      phone_normalized: `4478${String(10000000 + i)}`,
      opted_out_at: '2026-09-01T00:00:00Z',
    }));
    // Same number as contact c0, different contact row, opted out — last.
    others.push({
      id: 'dup',
      account_id: ACCOUNT,
      phone: phoneOf(0),
      phone_normalized: phoneOf(0).replace('+', ''),
      opted_out_at: '2026-09-01T00:00:00Z',
    });
    db.seed('contacts', others);
    const client = db.client();
    const ctx = await loadDeliveryContext(client, ACCOUNT, BC);
    const [res] = await deliverRecipientIds(client, ctx, ['r0'], ['pending']);
    expect(res).toMatchObject({ outcome: 'failed', error: 'Contact opted out' });
    expect(sendTemplateMessage).not.toHaveBeenCalled();
  });

  it('a number on the suppression list (anonymised opt-out, migration 077) is never sent', async () => {
    const db = seed(2);
    db.seed('contact_suppressions', [
      { account_id: ACCOUNT, phone_hash: suppressionHash(ACCOUNT, phoneOf(0)) as string },
    ]);
    const client = db.client();
    const ctx = await loadDeliveryContext(client, ACCOUNT, BC);
    const res = await deliverRecipientIds(client, ctx, ['r0', 'r1'], ['pending']);
    expect(res.find((r) => r.id === 'r0')).toMatchObject({ outcome: 'failed', error: 'Contact opted out' });
    expect(sendTemplateMessage).toHaveBeenCalledTimes(1);
  });

  it('opted-out contacts and bad phones are failed without a send', async () => {
    const db = seed(2);
    db.table('contacts')[0].opted_out_at = '2026-09-01T00:00:00Z';
    db.table('contacts')[1].phone = 'n/a';
    const client = db.client();
    const ctx = await loadDeliveryContext(client, ACCOUNT, BC);
    const res = await deliverRecipientIds(client, ctx, ['r0', 'r1'], ['pending']);
    expect(sendTemplateMessage).not.toHaveBeenCalled();
    expect(res.map((r) => [r.outcome, r.error])).toEqual([
      ['failed', 'Contact opted out'],
      ['failed', 'No valid phone number on contact'],
    ]);
  });

  it('sends the frozen params and the wizard header media', async () => {
    const db = seed(1);
    db.table('broadcasts')[0].header_media_url = 'https://cdn.test/a.jpg';
    const client = db.client();
    const ctx = await loadDeliveryContext(client, ACCOUNT, BC);
    await deliverRecipientIds(client, ctx, ['r0'], ['pending']);
    expect(sendTemplateMessage.mock.calls[0][0]).toMatchObject({
      params: ['Nome0'],
      messageParams: { headerMediaUrl: 'https://cdn.test/a.jpg' },
      accessToken: 'plain:enc',
    });
  });
});

describe('deliverBroadcast lock handling', () => {
  it('sends nothing when the lock is not (or no longer) mine', async () => {
    const db = seed(5, { lock: newLockToken() });
    const client = db.client();
    const ctx = await loadDeliveryContext(client, ACCOUNT, BC);
    const { lockToken } = await deliverBroadcast(client, ctx, {
      ids: ['r0', 'r1', 'r2', 'r3', 'r4'],
      from: ['pending'],
      lockToken: newLockToken(new Date('2020-01-01T00:00:00Z')), // someone else's
    });
    expect(lockToken).toBeNull();
    expect(sendTemplateMessage).not.toHaveBeenCalled();
  });

  it('renews its own lock per chunk and hands back the latest token', async () => {
    const token = newLockToken();
    const db = seed(25, { lock: token });
    const client = db.client();
    const ctx = await loadDeliveryContext(client, ACCOUNT, BC);
    const ids = db.table('broadcast_recipients').map((r) => r.id as string);
    const { lockToken } = await deliverBroadcast(client, ctx, { ids, from: ['pending'], lockToken: token });
    expect(lockToken).not.toBeNull();
    expect(lockToken).not.toBe(token);
    expect(db.table('broadcasts')[0].delivery_locked_at).toBe(lockToken);
    expect(sendTemplateMessage).toHaveBeenCalledTimes(25);
  });
});

describe('finalizeBroadcastStatus', () => {
  function withStatuses(statuses: string[]): FakeDb {
    const db = seed(statuses.length);
    db.table('broadcast_recipients').forEach((r, i) => {
      r.status = statuses[i];
      if (statuses[i] === 'sending') r.claimed_at = new Date().toISOString();
    });
    return db;
  }

  it('leaves the campaign "sending" while rows are pending', async () => {
    const db = withStatuses(['sent', 'pending']);
    await finalizeBroadcastStatus(db.client(), BC);
    expect(db.table('broadcasts')[0].status).toBe('sending');
  });

  it('leaves the campaign "sending" while rows are in flight', async () => {
    const db = withStatuses(['sent', 'sending']);
    await finalizeBroadcastStatus(db.client(), BC);
    expect(db.table('broadcasts')[0].status).toBe('sending');
  });

  it('marks a fully-failed campaign failed', async () => {
    const db = withStatuses(['failed', 'failed']);
    await finalizeBroadcastStatus(db.client(), BC);
    expect(db.table('broadcasts')[0].status).toBe('failed');
  });

  it('marks a partially-failed / uncertain campaign sent', async () => {
    const db = withStatuses(['sent', 'failed', 'uncertain']);
    await finalizeBroadcastStatus(db.client(), BC);
    expect(db.table('broadcasts')[0].status).toBe('sent');
  });

  it('does not call a campaign "sent" when every row is failed or uncertain', async () => {
    const mixed = withStatuses(['failed', 'uncertain']);
    await finalizeBroadcastStatus(mixed.client(), BC);
    expect(mixed.table('broadcasts')[0].status).toBe('failed');

    const allUncertain = withStatuses(['uncertain', 'uncertain']);
    await finalizeBroadcastStatus(allUncertain.client(), BC);
    expect(allUncertain.table('broadcasts')[0].status).toBe('failed');
  });
});

// Review fix (wacrm #534 follow-up): a webhook stub (needs_sync, no
// components) must not be broadcast — every recipient would fail.
describe('loadDeliveryContext — template stub awaiting sync', () => {
  it('refuses a needs_sync template with a 409 before any send', async () => {
    const db = seed(1);
    db.table('message_templates')[0].needs_sync = true;
    db.table('message_templates')[0].body_text = '';
    await expect(loadDeliveryContext(db.client(), ACCOUNT, BC)).rejects.toMatchObject({
      code: 'template_needs_sync',
      status: 409,
    });
    expect(sendTemplateMessage).not.toHaveBeenCalled();
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

// runAutoReplyJob / drainAutoReplies over the in-memory FakeDb, with
// send / model / sleep injected: what is checked is what reaches the
// customer, the job row and the conversation.

vi.mock('@/lib/automations/admin-client', () => ({ supabaseAdmin: () => ({}) }));
vi.mock('@/lib/automations/meta-send', () => ({ engineSendText: vi.fn() }));
const h = vi.hoisted(() => ({ module: true }));
vi.mock('@/lib/plans-server', () => ({ accountHasModule: async () => h.module }));

import { FakeDb } from '@/lib/whatsapp/fake-supabase.testkit';
import { AGENT_DEFAULTS, DEFAULT_BUSINESS_HOURS, DEFAULT_HANDOFF_MESSAGE } from './agents';
import { DEFAULT_STOP_CONFIRMATION } from './auto-reply';
import { drainAutoReplies, enqueueAutoReplyIfEligible, runAutoReplyJob, type AiReplyJob, type AutoReplyDeps } from './auto-reply-runtime';
import { AiError } from './errors';

const NOW = new Date('2026-09-29T15:00:00Z');

let db: FakeDb;
let sent: string[];
let modelText: string | Error;
let modelCalls: number;

function deps(over: Partial<AutoReplyDeps> = {}): AutoReplyDeps {
  return {
    db: db.client(),
    send: async (a) => {
      sent.push(a.text);
    },
    runModel: (async () => {
      modelCalls++;
      if (modelText instanceof Error) throw modelText;
      return { text: modelText, provider: 'openai', model: 'm', inputTokens: 1, outputTokens: 1, costCents: 0 };
    }) as AutoReplyDeps['runModel'],
    hasAiModule: async () => true,
    sleep: async () => {},
    now: () => NOW,
    random: () => 0,
    ...over,
  };
}

const job = (over: Partial<AiReplyJob> = {}): AiReplyJob => ({
  id: 'job-1',
  account_id: 'acc',
  conversation_id: 'conv',
  contact_id: 'ct',
  agent_id: 'ag',
  status: 'running',
  attempts: 1,
  reply_parts: null,
  sent_parts: 0,
  ...over,
});

const reply = (r: string) => JSON.stringify({ reply: r, handoff: false, reason: '' });

beforeEach(() => {
  h.module = true;
  db = new FakeDb();
  sent = [];
  modelCalls = 0;
  modelText = reply('Olá! Abrimos às 8h.');
  db.seed('accounts', [{ id: 'acc', name: 'Padaria' }]);
  db.seed('ai_settings', [{ account_id: 'acc', enabled: true, instructions: 'Horário: 8h às 18h.' }]);
  db.seed('ai_agents', [
    {
      id: 'ag',
      account_id: 'acc',
      name: 'Atendente',
      instructions: 'Ajude',
      tone: null,
      model: null,
      knowledge_enabled: false,
      is_default: true,
      enabled: true,
      channels: [],
      tag_ids: [],
      ...AGENT_DEFAULTS,
      mode: 'auto',
      paused_at: null,
      business_hours: { ...DEFAULT_BUSINESS_HOURS },
      handoff_keywords: ['falar com atendente'],
      handoff_message: null,
      created_at: '2026-01-01T00:00:00Z',
    },
  ]);
  db.seed('contacts', [{ id: 'ct', account_id: 'acc', name: 'Ana', opted_out_at: null, anonymized_at: null }]);
  db.seed('conversations', [
    {
      id: 'conv',
      account_id: 'acc',
      user_id: 'owner',
      contact_id: 'ct',
      status: 'open',
      archived_at: null,
      channel: 'qr',
      ai_paused_until: null,
      last_customer_message_at: '2026-09-29T14:59:00Z',
    },
  ]);
  db.seed('messages', [
    { id: 'm1', conversation_id: 'conv', sender_type: 'customer', content_type: 'text', content_text: 'Que horas vocês abrem?', created_at: '2026-09-29T14:59:00Z' },
  ]);
  db.seed('ai_reply_jobs', [{ ...job(), status: 'running' }]);
});

const jobRow = () => db.table('ai_reply_jobs').find((j) => j.id === 'job-1')!;
const conv = () => db.table('conversations')[0];

describe('runAutoReplyJob', () => {
  it('replies, records the job and the conversation', async () => {
    await expect(runAutoReplyJob(job(), deps())).resolves.toBe('replied');
    expect(sent).toEqual(['Olá! Abrimos às 8h.']);
    expect(jobRow()).toMatchObject({ status: 'done', outcome: 'replied', sent_parts: 1, reply_parts: null });
    expect(conv().ai_last_reply_at).toBe(NOW.toISOString());
  });

  it('splits into bubbles with typing delay then gaps', async () => {
    modelText = reply('Oi!\n\nAbrimos às 8h.\n\nAté logo.');
    const sleeps: number[] = [];
    await runAutoReplyJob(job(), deps({ sleep: async (ms) => void sleeps.push(ms) }));
    expect(sent).toHaveLength(3);
    expect(sleeps).toEqual([1200, 1200, 1200]);
  });

  it('a retry never re-sends bubbles already sent and does not call the model', async () => {
    const parts = ['Parte 1', 'Parte 2'];
    Object.assign(jobRow(), { reply_parts: parts, sent_parts: 1, attempts: 2 });
    await expect(runAutoReplyJob(job({ reply_parts: parts, sent_parts: 1, attempts: 2 }), deps())).resolves.toBe('replied');
    expect(sent).toEqual(['Parte 2']);
    expect(modelCalls).toBe(0);
  });

  it('stops mid-way when a human replied (pause) before the next bubble', async () => {
    modelText = reply('Um.\n\nDois.');
    let n = 0;
    await runAutoReplyJob(
      job(),
      deps({
        send: async (a) => {
          sent.push(a.text);
          if (++n === 1) conv().ai_paused_until = '2026-09-29T15:30:00Z';
        },
      }),
    );
    expect(sent).toEqual(['Um.']);
    expect(jobRow()).toMatchObject({ status: 'skipped', skip_reason: 'ai_paused', sent_parts: 1 });
  });

  it('customer asks for a person → hand-over before the model', async () => {
    db.table('messages').push({ id: 'm2', conversation_id: 'conv', sender_type: 'customer', content_type: 'text', content_text: 'quero falar com um atendente', created_at: '2026-09-29T14:59:30Z' });
    await expect(runAutoReplyJob(job(), deps())).resolves.toBe('handoff');
    expect(modelCalls).toBe(0);
    expect(sent).toEqual([DEFAULT_HANDOFF_MESSAGE]);
    expect(conv()).toMatchObject({ ai_paused_until: 'infinity', status: 'pending' });
    expect(db.table('ai_handoffs')[0]).toMatchObject({ conversation_id: 'conv', notified: true, last_customer_words: expect.stringContaining('atendente') });
    expect(db.table('conversation_events')[0]).toMatchObject({ event_type: 'ai_handoff' });
    expect(jobRow()).toMatchObject({ status: 'done', outcome: 'handoff' });
  });

  it('hand-over notice that fails to send is recorded as not notified', async () => {
    modelText = JSON.stringify({ reply: null, handoff: true, reason: 'Sem informação', customer_wants: 'Saber o preço' });
    await runAutoReplyJob(job(), deps({ send: async () => { throw new Error('131047 outside window'); } }));
    expect(db.table('ai_handoffs')[0]).toMatchObject({ notified: false, reason: 'Sem informação', customer_wants: 'Saber o preço' });
  });

  it('invalid model output, invented price and AI unavailable → hand-over, nothing else sent', async () => {
    modelText = 'Claro, abrimos às 8h';
    await expect(runAutoReplyJob(job(), deps())).resolves.toBe('handoff');
    expect(sent).toEqual([DEFAULT_HANDOFF_MESSAGE]);

    beforeEachReset();
    modelText = reply('Custa R$ 99,00 com 20% de desconto');
    await expect(runAutoReplyJob(job(), deps())).resolves.toBe('handoff');
    expect(String(db.table('ai_handoffs')[0].reason)).toContain('r$ 99,00');

    beforeEachReset();
    modelText = new AiError('budget_exceeded');
    await expect(runAutoReplyJob(job(), deps())).resolves.toBe('handoff');
  });

  it('a transient model error is thrown for a retry until the last attempt', async () => {
    modelText = new AiError('timeout');
    await expect(runAutoReplyJob(job({ attempts: 1 }), deps())).rejects.toThrow();
    await expect(runAutoReplyJob(job({ attempts: 3 }), deps())).resolves.toBe('handoff');
  });

  it('STOP → confirmation + opt-out', async () => {
    db.table('messages')[0].content_text = 'me tira da lista';
    await expect(runAutoReplyJob(job(), deps())).resolves.toBe('opted_out');
    expect(sent).toEqual([DEFAULT_STOP_CONFIRMATION]);
    expect(db.table('contacts')[0].opted_out_at).toBe(NOW.toISOString());
    expect(db.table('conversation_events')[0]).toMatchObject({ event_type: 'contact_opted_out' });
  });

  it('skips: paused conversation, nothing to answer, module off', async () => {
    conv().ai_paused_until = 'infinity';
    await expect(runAutoReplyJob(job(), deps())).resolves.toBe('skipped');
    expect(jobRow().skip_reason).toBe('ai_paused');

    conv().ai_paused_until = null;
    db.table('messages').push({ id: 'm9', conversation_id: 'conv', sender_type: 'agent', content_type: 'text', content_text: 'oi', created_at: '2026-09-29T14:59:50Z' });
    await runAutoReplyJob(job(), deps());
    expect(jobRow().skip_reason).toBe('nothing_to_answer');

    await runAutoReplyJob(job(), deps({ hasAiModule: async () => false }));
    expect(jobRow().skip_reason).toBe('module_off');
    expect(sent).toEqual([]);
  });

  it('outside business hours → rescheduled, attempt not counted', async () => {
    (db.table('ai_agents')[0] as Record<string, unknown>).business_hours = { ...DEFAULT_BUSINESS_HOURS, enabled: true, start: '13:00' };
    await expect(runAutoReplyJob(job({ attempts: 1 }), deps())).resolves.toBe('rescheduled');
    expect(jobRow()).toMatchObject({ status: 'queued', run_after: '2026-09-29T16:00:00.000Z', attempts: 0 });
  });

  it('daily cap → hand-over', async () => {
    (db.table('ai_agents')[0] as Record<string, unknown>).max_auto_replies_per_day = 1;
    db.seed('ai_reply_jobs', [{ id: 'old', conversation_id: 'conv', status: 'done', outcome: 'replied', updated_at: '2026-09-29T13:00:00Z' }]);
    await expect(runAutoReplyJob(job(), deps())).resolves.toBe('handoff');
    expect(modelCalls).toBe(0);
  });
});

function beforeEachReset() {
  sent = [];
  db.table('ai_handoffs').length = 0;
  Object.assign(conv(), { ai_paused_until: null, status: 'open' });
}

describe('drainAutoReplies', () => {
  it('claims through the RPC and requeues a failed job with back-off', async () => {
    db.rpcHandler = (fn) => (fn === 'ai_reply_claim' ? { data: [job()], error: null } : { data: null, error: null });
    const r = await drainAutoReplies(deps({ runModel: (async () => { throw new Error('db down'); }) as AutoReplyDeps['runModel'] }));
    expect(r).toMatchObject({ claimed: 1, failed: 1 });
    expect(jobRow()).toMatchObject({ status: 'queued', last_error: 'db down', run_after: '2026-09-29T15:00:30.000Z' });
  });

  it('fails for good after the last attempt', async () => {
    db.rpcHandler = () => ({ data: [job({ attempts: 3 })], error: null });
    await drainAutoReplies(deps({ hasAiModule: async () => { throw new Error('db down'); } }));
    expect(jobRow()).toMatchObject({ status: 'failed' });
  });
});

describe('enqueueAutoReplyIfEligible', () => {
  it('queues through the RPC only for an auto agent and an eligible conversation', async () => {
    const calls: unknown[] = [];
    db.rpcHandler = (fn, args) => {
      calls.push([fn, args]);
      return { data: 'job', error: null };
    };
    const input = { accountId: 'acc', conversation: conv(), contact: db.table('contacts')[0], messageId: 'm1', now: NOW };
    expect(await enqueueAutoReplyIfEligible(db.client(), input)).toBe(true);
    expect(calls).toEqual([
      ['ai_reply_enqueue', { p_account_id: 'acc', p_conversation_id: 'conv', p_contact_id: 'ct', p_agent_id: 'ag', p_message_id: 'm1', p_delay_seconds: 8 }],
    ]);
    conv().ai_paused_until = 'infinity';
    expect(await enqueueAutoReplyIfEligible(db.client(), input)).toBe(false);
    conv().ai_paused_until = null;
    (db.table('ai_agents')[0] as Record<string, unknown>).mode = 'suggest';
    expect(await enqueueAutoReplyIfEligible(db.client(), input)).toBe(false);
    (db.table('ai_agents')[0] as Record<string, unknown>).mode = 'auto';
    h.module = false;
    expect(await enqueueAutoReplyIfEligible(db.client(), input)).toBe(false);
    expect(calls).toHaveLength(1);
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

// runAutoReplyJob / drain over the in-memory FakeDb, with send / pace /
// model / sleep injected: what is checked is what reaches the customer,
// the job row and the conversation.

vi.mock('@/lib/automations/admin-client', () => ({ supabaseAdmin: () => ({}) }));
vi.mock('@/lib/automations/meta-send', () => ({ engineSendText: vi.fn() }));
const h = vi.hoisted(() => ({ module: true }));
vi.mock('@/lib/plans-server', () => ({ accountHasModule: async () => h.module }));
const pushes = vi.hoisted(() => [] as { accountId: string; tag?: string }[]);
vi.mock('@/lib/push/notify', () => ({
  notifyAccountAdmins: async (_db: unknown, accountId: string, p: { tag?: string }) => {
    pushes.push({ accountId, tag: p.tag });
  },
}));

import type { SupabaseClient } from '@supabase/supabase-js';
import { MetaSendError } from '@/lib/whatsapp/meta-api';
import { FakeDb, type Row } from '@/lib/whatsapp/fake-supabase.testkit';
import { AGENT_DEFAULTS, DEFAULT_BUSINESS_HOURS, DEFAULT_HANDOFF_MESSAGE } from './agents';
import {
  claimAutoReplies,
  drainAutoReplies,
  enqueueAutoReplyIfEligible,
  resetAutoReplyConcurrency,
  runAutoReplyJob,
  type AiReplyJob,
  type AutoReplyDeps,
} from './auto-reply-runtime';
import { resetAccountCapWarnings } from './automatic-cap';
import { AiError } from './errors';

const NOW = new Date('2026-09-29T15:00:00Z');

let db: FakeDb;
let sent: string[];
let modelText: string | Error;
let prompts: string[];
let paced: number;

function deps(over: Partial<AutoReplyDeps> = {}): AutoReplyDeps {
  return {
    db: db.client(),
    send: async (a) => {
      sent.push(a.text);
    },
    pace: async () => {
      paced++;
    },
    runModel: (async (input: { prompt: string }) => {
      prompts.push(input.prompt);
      if (modelText instanceof Error) throw modelText;
      return { text: modelText, provider: 'openai', model: 'm', inputTokens: 1, outputTokens: 1, costCents: 0 };
    }) as unknown as AutoReplyDeps['runModel'],
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
  inbound_message_ids: ['m1'],
  ...over,
});

const reply = (r: string) => JSON.stringify({ reply: r, handoff: false, reason: '' });
const msg = (id: string, over: Row = {}): Row => ({
  id,
  conversation_id: 'conv',
  sender_type: 'customer',
  content_type: 'text',
  content_text: 'oi',
  created_at: '2026-09-29T14:59:00Z',
  ...over,
});

beforeEach(() => {
  h.module = true;
  pushes.length = 0;
  resetAccountCapWarnings();
  resetAutoReplyConcurrency();
  db = new FakeDb();
  sent = [];
  prompts = [];
  paced = 0;
  modelText = reply('Olá! Abrimos às 8h.');
  db.seed('accounts', [{ id: 'acc', name: 'Padaria' }]);
  db.seed('ai_settings', [{ account_id: 'acc', enabled: true, instructions: 'Horário: 8h às 18h.' }]);
  db.seed('ai_agents', [
    {
      id: 'ag',
      account_id: 'acc',
      name: 'Atendente',
      instructions: 'Ajude os clientes da padaria com educação e sempre confirme o pedido antes de encerrar.',
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
  db.seed('messages', [msg('m1', { content_text: 'Que horas vocês abrem?' })]);
  db.seed('ai_reply_jobs', [{ ...job(), status: 'running' }]);
});

const jobRow = (id = 'job-1') => db.table('ai_reply_jobs').find((j) => j.id === id)!;
const conv = () => db.table('conversations')[0];
const agentRow = () => db.table('ai_agents')[0] as Row;

function failingJobWrites(shouldFail: (patch: Row) => boolean): SupabaseClient {
  const client = db.client();
  return {
    rpc: client.rpc,
    from: (table: string) => {
      const query = client.from(table) as unknown as {
        update: (patch: Row) => unknown;
      };
      if (table !== 'ai_reply_jobs') return query;
      const update = query.update.bind(query);
      query.update = (patch: Row) => {
        if (!shouldFail(patch)) return update(patch);
        const result = {
          data: null,
          error: { message: 'SENSITIVE database diagnostic' },
        };
        return {
          eq: () => ({
            select: async () => result,
            then: (resolve: (value: unknown) => unknown) =>
              Promise.resolve(result).then(resolve),
          }),
        };
      };
      return query;
    },
  } as unknown as SupabaseClient;
}

describe('durable automatic-reply job writes', () => {
  it.each([
    ['prepared reply', (patch: Row) => Array.isArray(patch.reply_parts)],
    ['first bubble checkpoint', (patch: Row) => patch.sent_parts === 1],
  ])(
    'does not send when the %s cannot be recorded',
    async (_name, shouldFail) => {
      await expect(
        runAutoReplyJob(job(), deps({ db: failingJobWrites(shouldFail) }))
      ).rejects.toThrow('ai reply job update failed');
      expect(sent).toEqual([]);
      expect(jobRow().sent_parts).toBe(0);
    }
  );

  it('does not send when the job disappeared during pacing', async () => {
    await expect(
      runAutoReplyJob(
        job(),
        deps({ pace: async () => void db.tables.set('ai_reply_jobs', []) })
      )
    ).rejects.toThrow('ai reply job update failed');
    expect(sent).toEqual([]);
  });

  it('retries only the unsent bubble after its checkpoint fails', async () => {
    modelText = reply('Um.\n\nDois.');
    db.rpcHandler = () => ({ data: [{ ...jobRow() }], error: null });
    let failure = true;
    const flaky = failingJobWrites((patch) => {
      if (patch.sent_parts !== 2 || !failure) return false;
      failure = false;
      return true;
    });
    const first = await drainAutoReplies(deps({ db: flaky }));
    expect(first).toMatchObject({ failed: 1, replied: 0 });
    expect(sent).toEqual(['Um.']);
    expect(jobRow()).toMatchObject({
      status: 'queued',
      sent_parts: 1,
      reply_parts: ['Um.', 'Dois.'],
    });
    const second = await drainAutoReplies(deps({ db: flaky }));
    expect(second).toMatchObject({ failed: 0, replied: 1 });
    expect(sent).toEqual(['Um.', 'Dois.']);
    expect(prompts).toHaveLength(1);
  });

  it('does not resend after recording completion fails', async () => {
    db.rpcHandler = () => ({ data: [{ ...jobRow() }], error: null });
    let failure = true;
    const flaky = failingJobWrites((patch) => {
      if (patch.status !== 'done' || !failure) return false;
      failure = false;
      return true;
    });
    expect(await drainAutoReplies(deps({ db: flaky }))).toMatchObject({
      failed: 1,
    });
    expect(sent).toEqual(['Olá! Abrimos às 8h.']);
    expect(jobRow()).toMatchObject({ status: 'queued', sent_parts: 1 });
    expect(await drainAutoReplies(deps({ db: flaky }))).toMatchObject({
      replied: 1,
      failed: 0,
    });
    expect(sent).toEqual(['Olá! Abrimos às 8h.']);
    expect(prompts).toHaveLength(1);
  });
});

describe('runAutoReplyJob — reply', () => {
  it('replies, records the job, the agent used and the conversation', async () => {
    jobRow().agent_id = null;
    await expect(runAutoReplyJob(job({ agent_id: null }), deps())).resolves.toBe('replied');
    expect(sent).toEqual(['Olá! Abrimos às 8h.']);
    expect(jobRow()).toMatchObject({ status: 'done', outcome: 'replied', sent_parts: 1, reply_parts: null, agent_id: 'ag' });
    expect(conv().ai_last_reply_at).toBe(NOW.toISOString());
    expect(prompts[0]).toContain('<mensagens_sem_resposta>\n{"de":"cliente","texto":"Que horas vocês abrem?"}');
  });

  it('bubbles: typing delay, gaps, pacing before each send', async () => {
    modelText = reply('Oi!\n\nAbrimos às 8h.\n\nAté logo.');
    const sleeps: number[] = [];
    await runAutoReplyJob(job(), deps({ sleep: async (ms) => void sleeps.push(ms) }));
    expect(sent).toHaveLength(3);
    expect(sleeps).toEqual([1200, 1200, 1200]);
    expect(paced).toBe(3);
  });

  it('customer types while the AI types: the follow-up (older timestamp than our bubble) is answered by the next job', async () => {
    // Job 1 answers m1; while its bubble goes out the customer sends m2,
    // stamped with WhatsApp seconds — BEFORE our bubble's now().
    await runAutoReplyJob(
      job(),
      deps({
        send: async (a) => {
          sent.push(a.text);
          db.table('messages').push(msg('m2', { content_text: 'E aos domingos?', created_at: '2026-09-29T14:59:59Z' }));
          db.table('messages').push(
            msg('ai1', { sender_type: 'bot', origin: 'ai', content_text: a.text, created_at: '2026-09-29T15:00:00.900Z' }),
          );
        },
      }),
    );
    db.seed('ai_reply_jobs', [{ ...job({ id: 'job-2', inbound_message_ids: ['m2'] }) }]);
    modelText = reply('Aos domingos também abrimos às 8h.');
    await expect(runAutoReplyJob(job({ id: 'job-2', inbound_message_ids: ['m2'] }), deps())).resolves.toBe('replied');
    expect(sent).toEqual(['Olá! Abrimos às 8h.', 'Aos domingos também abrimos às 8h.']);
    expect(prompts[1]).toContain('<mensagens_sem_resposta>\n{"de":"cliente","texto":"E aos domingos?"}');
  });

  it('a retry resumes the unsent bubbles without calling the model', async () => {
    const parts = ['Parte 1', 'Parte 2'];
    await expect(runAutoReplyJob(job({ reply_parts: parts, sent_parts: 1, attempts: 2 }), deps())).resolves.toBe('replied');
    expect(sent).toEqual(['Parte 2']);
    expect(prompts).toHaveLength(0);
  });

  it('the last-moment check runs after the pacing wait (human paused during it)', async () => {
    await runAutoReplyJob(job(), deps({ pace: async () => void (conv().ai_paused_until = '2026-09-29T15:30:00Z') }));
    expect(sent).toEqual([]);
    expect(jobRow()).toMatchObject({ status: 'skipped', skip_reason: 'ai_paused' });
  });

  it.each([
    ['ai_paused', () => void (conv().ai_paused_until = 'infinity')],
    ['contact_opted_out', () => void (db.table('contacts')[0].opted_out_at = 'x')],
    ['agent_paused', () => void (agentRow().paused_at = 'x')],
    ['agent_paused', () => void (agentRow().mode = 'suggest')],
    ['ai_disabled', () => void (db.table('ai_settings')[0].enabled = false)],
  ])('stops before the next bubble: %s', async (reason, change) => {
    modelText = reply('Um.\n\nDois.');
    let n = 0;
    await runAutoReplyJob(
      job(),
      deps({
        send: async (a) => {
          sent.push(a.text);
          if (++n === 1) change();
        },
      }),
    );
    expect(sent).toEqual(['Um.']);
    expect(jobRow()).toMatchObject({ status: 'skipped', skip_reason: reason, sent_parts: 1 });
  });
});

describe('runAutoReplyJob — sends that may or may not have gone out', () => {
  it('uncertain send: bubble counted, no retry, silent hand-over', async () => {
    modelText = reply('Um.\n\nDois.');
    await expect(
      runAutoReplyJob(
        job(),
        deps({
          send: async () => {
            throw new MetaSendError('timeout', { uncertain: true });
          },
        }),
      ),
    ).resolves.toBe('handoff');
    expect(jobRow()).toMatchObject({ sent_parts: 1, status: 'done', outcome: 'handoff' });
    expect(db.table('ai_handoffs')[0]).toMatchObject({ notified: false });
    expect(sent).toEqual([]);
  });

  it('"sent … but DB insert failed" is treated as sent', async () => {
    await runAutoReplyJob(
      job(),
      deps({
        send: async () => {
          throw new Error('sent via gateway but DB insert failed: x');
        },
      }),
    );
    expect(jobRow()).toMatchObject({ sent_parts: 1, outcome: 'handoff' });
  });

  it('a send refused before leaving is retried from the same bubble', async () => {
    db.rpcHandler = () => ({ data: [job()], error: null });
    const r = await drainAutoReplies(
      deps({
        send: async () => {
          throw new MetaSendError('(#131026) not on WhatsApp', { uncertain: false });
        },
      }),
    );
    expect(r.failed).toBe(1);
    expect(jobRow()).toMatchObject({ status: 'queued', sent_parts: 0, reply_parts: ['Olá! Abrimos às 8h.'] });
  });
});

describe('runAutoReplyJob — stay out / hand over', () => {
  it('an automation or flow already answered after the customer → skip', async () => {
    db.table('messages').push(msg('b1', { sender_type: 'bot', origin: 'automation', created_at: '2026-09-29T14:59:01Z' }));
    await expect(runAutoReplyJob(job(), deps())).resolves.toBe('skipped');
    expect(jobRow().skip_reason).toBe('automation_answered');
    expect(sent).toEqual([]);
  });

  it('customer inside an active flow → skip', async () => {
    db.seed('flow_runs', [{ id: 'r', account_id: 'acc', contact_id: 'ct', status: 'active' }]);
    await runAutoReplyJob(job(), deps());
    expect(jobRow().skip_reason).toBe('flow_active');
  });

  it('customer asks for a person → hand-over with notice, before the model', async () => {
    db.table('messages').push(msg('m2', { content_text: 'quero falar com um atendente' }));
    await expect(runAutoReplyJob(job({ inbound_message_ids: ['m1', 'm2'] }), deps())).resolves.toBe('handoff');
    expect(prompts).toHaveLength(0);
    expect(sent).toEqual([DEFAULT_HANDOFF_MESSAGE]);
    expect(conv()).toMatchObject({ ai_paused_until: 'infinity', status: 'pending' });
    expect(db.table('ai_handoffs')[0]).toMatchObject({ notified: true, last_customer_words: expect.stringContaining('atendente') });
    expect(db.table('conversation_events')[0]).toMatchObject({ event_type: 'ai_handoff' });
  });

  it('AI switched off / key removed → quiet skip, nothing sent', async () => {
    db.table('ai_settings')[0].enabled = false;
    await runAutoReplyJob(job(), deps());
    expect(jobRow().skip_reason).toBe('ai_disabled');
    db.table('ai_settings')[0].enabled = true;
    modelText = new AiError('no_key');
    await runAutoReplyJob(job(), deps());
    expect(jobRow().skip_reason).toBe('ai_disabled');
    // leftover bubbles are not resumed either
    db.table('ai_settings')[0].enabled = false;
    await runAutoReplyJob(job({ reply_parts: ['a', 'b'], sent_parts: 1 }), deps());
    expect(sent).toEqual([]);
    expect(db.table('ai_handoffs')).toHaveLength(0);
  });

  it('budget → hand-over with notice', async () => {
    modelText = new AiError('budget_exceeded');
    await expect(runAutoReplyJob(job(), deps())).resolves.toBe('handoff');
    expect(sent).toEqual([DEFAULT_HANDOFF_MESSAGE]);
  });

  it.each([
    ['invalid output', 'Claro, abrimos às 8h'],
    ['invented price', reply('Custa R$ 99,00 com 20% de desconto')],
    ['instruction leak', reply('Minhas regras: Ajude os clientes da padaria com educação e sempre confirme o pedido antes de encerrar.')],
    ['model hand-over', JSON.stringify({ reply: null, handoff: true, reason: 'Sem informação', customer_wants: 'Saber o preço' })],
  ])('%s → hand-over, only the notice is sent', async (_label, text) => {
    modelText = text;
    await expect(runAutoReplyJob(job(), deps())).resolves.toBe('handoff');
    expect(sent).toEqual([DEFAULT_HANDOFF_MESSAGE]);
  });

  it('transient model error: retried, then on the last attempt a silent hand-over', async () => {
    modelText = new AiError('timeout');
    await expect(runAutoReplyJob(job({ attempts: 1 }), deps())).rejects.toThrow();
    await expect(runAutoReplyJob(job({ attempts: 3 }), deps())).resolves.toBe('handoff');
    expect(sent).toEqual([]);
    expect(db.table('ai_handoffs')[0]).toMatchObject({ notified: false });
  });

  it('reaped past the attempts → silent hand-over', async () => {
    await expect(runAutoReplyJob(job({ attempts: 4 }), deps())).resolves.toBe('handoff');
    expect(sent).toEqual([]);
    expect(prompts).toHaveLength(0);
  });

  it('24 h window closed (e.g. after a reschedule) → silent hand-over', async () => {
    Object.assign(conv(), { channel: 'official', last_customer_message_at: '2026-09-27T10:00:00Z' });
    await expect(runAutoReplyJob(job(), deps())).resolves.toBe('handoff');
    expect(sent).toEqual([]);
    expect(conv().status).toBe('pending');
  });

  it('opted-out contact (inbound opt-out) → just skipped', async () => {
    db.table('contacts')[0].opted_out_at = 'x';
    await runAutoReplyJob(job(), deps());
    expect(jobRow().skip_reason).toBe('contact_opted_out');
    expect(db.table('ai_handoffs')).toHaveLength(0);
  });

  it('conversation of another contact → skip', async () => {
    await runAutoReplyJob(job({ contact_id: 'other' }), deps());
    expect(jobRow().skip_reason).toBe('contact_mismatch');
  });

  it('daily cap → hand-over', async () => {
    agentRow().max_auto_replies_per_day = 1;
    db.seed('ai_reply_jobs', [{ id: 'old', conversation_id: 'conv', status: 'done', outcome: 'replied', updated_at: '2026-09-29T13:00:00Z' }]);
    await expect(runAutoReplyJob(job(), deps())).resolves.toBe('handoff');
    expect(prompts).toHaveLength(0);
  });

  const seedUsage = (n: number, convId: string) =>
    db.seed(
      'ai_usage',
      Array.from({ length: n }, (_, i) => ({
        id: `u${i}`,
        account_id: 'acc',
        user_id: null,
        conversation_id: convId,
        feature: i % 2 ? 'triage' : 'auto_reply',
        status: i % 3 ? 'ok' : 'blocked',
        created_at: '2026-09-29T14:30:00Z',
      })),
    );

  it('hourly contact cap → silent hand-over of that conversation, no model call', async () => {
    seedUsage(30, 'conv');
    await expect(runAutoReplyJob(job(), deps())).resolves.toBe('handoff');
    expect(prompts).toHaveLength(0);
    expect(sent).toEqual([]);
    expect(conv()).toMatchObject({ ai_paused_until: 'infinity' });
    expect(db.table('ai_handoffs')[0].reason).toContain('Limite por hora');
    expect(pushes).toHaveLength(0);
  });

  it('hourly account cap → the job waits, the AI is NOT paused, admins get one push per hour', async () => {
    seedUsage(300, 'conv-other');
    await expect(runAutoReplyJob(job({ attempts: 2 }), deps())).resolves.toBe('rescheduled');
    expect(prompts).toHaveLength(0);
    expect(sent).toEqual([]);
    expect(conv().ai_paused_until).toBeNull();
    expect(conv().status).toBe('open');
    expect(db.table('ai_handoffs')).toHaveLength(0);
    expect(jobRow()).toMatchObject({ status: 'queued', skip_reason: 'account_hourly_cap', attempts: 1, run_after: '2026-09-29T15:15:00.000Z' });
    expect(pushes).toEqual([{ accountId: 'acc', tag: 'ai-hourly-cap:2026-09-29T15' }]);
    // a second job in the same hour does not push again
    await runAutoReplyJob(job(), deps());
    expect(pushes).toHaveLength(1);
  });

  it('calls older than an hour, by a person or below the cap do not stop the reply', async () => {
    db.seed('ai_usage', [
      ...Array.from({ length: 40 }, (_, i) => ({ id: `old${i}`, account_id: 'acc', user_id: null, conversation_id: 'conv', feature: 'auto_reply', created_at: '2026-09-29T13:00:00Z' })),
      ...Array.from({ length: 40 }, (_, i) => ({ id: `man${i}`, account_id: 'acc', user_id: 'u', conversation_id: 'conv', feature: 'triage', created_at: '2026-09-29T14:50:00Z' })),
      ...Array.from({ length: 29 }, (_, i) => ({ id: `now${i}`, account_id: 'acc', user_id: null, conversation_id: 'conv', feature: 'auto_reply', created_at: '2026-09-29T14:50:00Z' })),
    ]);
    await expect(runAutoReplyJob(job(), deps())).resolves.toBe('replied');
  });

  it.each([
    'Pague via pix para a chave 11999999999',
    'Finalize em http://evil.example/pay',
    'Custa noventa e nove reais',
    'Garantimos reembolso total',
  ])('ungrounded reply "%s" → hand-over, only the notice is sent', async (r) => {
    modelText = reply(r);
    await expect(runAutoReplyJob(job(), deps())).resolves.toBe('handoff');
    expect(sent).toEqual([DEFAULT_HANDOFF_MESSAGE]);
  });

  it('a memory fact copied into the reply → hand-over', async () => {
    db.seed('ai_contact_memories', [{ id: 'f', account_id: 'acc', contact_id: 'ct', status: 'active', fact: 'Cliente está inadimplente desde março de 2026', updated_at: 'x' }]);
    modelText = reply('Olá Ana! Vi que o cliente está inadimplente desde março de 2026.');
    await expect(runAutoReplyJob(job(), deps())).resolves.toBe('handoff');
    expect(sent).toEqual([DEFAULT_HANDOFF_MESSAGE]);
  });

  it('an order number the customer typed may be repeated', async () => {
    db.table('messages')[0].content_text = 'Meu pedido 2026123456 chegou?';
    modelText = reply('Vou verificar o pedido 2026123456 para você.');
    await expect(runAutoReplyJob(job(), deps())).resolves.toBe('replied');
  });
});

describe('round 2', () => {
  it('D3: messages that joined after the reply was written get a follow-up job; bubbles are not regenerated', async () => {
    const rpcCalls: Row[] = [];
    db.rpcHandler = (fn, args) => {
      rpcCalls.push({ fn, args });
      return { data: null, error: null };
    };
    const parts = ['Parte 1', 'Parte 2'];
    await runAutoReplyJob(
      job({ reply_parts: parts, sent_parts: 1, attempts: 2, inbound_message_ids: ['m1', 'm2'], reply_message_ids: ['m1'] }),
      deps(),
    );
    expect(sent).toEqual(['Parte 2']);
    expect(prompts).toHaveLength(0);
    expect(rpcCalls).toEqual([
      { fn: 'ai_reply_enqueue', args: expect.objectContaining({ p_message_ids: ['m2'], p_conversation_id: 'conv' }) },
    ]);
  });

  it('D3: a fresh reply records which messages it answers, so nothing extra is queued', async () => {
    const rpcCalls: string[] = [];
    db.rpcHandler = (fn) => {
      rpcCalls.push(fn);
      return { data: null, error: null };
    };
    await runAutoReplyJob(job(), deps());
    expect(jobRow().reply_message_ids).toEqual(['m1']);
    expect(rpcCalls).toEqual([]);
  });

  it('D3: a requeue conflict with bubbles already out keeps THIS job and merges the newer one into it', async () => {
    agentRow().business_hours = { ...DEFAULT_BUSINESS_HOURS, enabled: true, start: '13:00' };
    Object.assign(jobRow(), { reply_parts: ['a', 'b'], sent_parts: 1 });
    db.seed('ai_reply_jobs', [{ id: 'job-2', conversation_id: 'conv', status: 'queued', inbound_message_ids: ['m9'] }]);
    const client = db.client();
    let conflicts = 1;
    const unique = {
      rpc: client.rpc,
      from: (t: string) => {
        const q = client.from(t) as unknown as { update: (p: Row) => unknown };
        if (t !== 'ai_reply_jobs') return q;
        const update = q.update.bind(q);
        q.update = (p: Row) =>
          p.status === 'queued' && p.run_after && conflicts-- > 0
            ? { eq: async () => ({ error: { code: '23505', message: 'duplicate' } }) }
            : update(p);
        return q;
      },
    } as unknown as SupabaseClient;
    await runAutoReplyJob(job({ reply_parts: ['a', 'b'], sent_parts: 1 }), deps({ db: unique }));
    expect(jobRow()).toMatchObject({ status: 'queued', reply_parts: ['a', 'b'], sent_parts: 1, inbound_message_ids: ['m1', 'm9'] });
    expect(jobRow('job-2')).toMatchObject({ status: 'skipped', skip_reason: 'merged' });
  });

  it('at-most-once: the bubble is recorded as sent before the request leaves (a crash never re-sends it)', async () => {
    let recordedDuringSend = -1;
    await runAutoReplyJob(
      job(),
      deps({
        send: async (a) => {
          recordedDuringSend = jobRow().sent_parts as number;
          sent.push(a.text);
        },
      }),
    );
    expect(recordedDuringSend).toBe(1);
    // crash after the last bubble was recorded: complete, nothing generated or sent again
    sent = [];
    prompts = [];
    Object.assign(jobRow(), { status: 'running', reply_parts: ['x'], sent_parts: 1 });
    await expect(runAutoReplyJob(job({ reply_parts: ['x'], sent_parts: 1, attempts: 2 }), deps())).resolves.toBe('replied');
    expect(sent).toEqual([]);
    expect(prompts).toHaveLength(0);
  });

  it('daily cap does not stop a reply already written and partly sent', async () => {
    agentRow().max_auto_replies_per_day = 1;
    db.seed('ai_reply_jobs', [{ id: 'old', conversation_id: 'conv', status: 'done', outcome: 'replied', updated_at: '2026-09-29T13:00:00Z' }]);
    await expect(runAutoReplyJob(job({ reply_parts: ['a', 'b'], sent_parts: 1, attempts: 2 }), deps())).resolves.toBe('replied');
    expect(sent).toEqual(['b']);
  });

  it('D4: hand-over notice is skipped when a person took over meanwhile, the card is still recorded', async () => {
    modelText = JSON.stringify({ reply: null, handoff: true, reason: 'Sem informação' });
    await runAutoReplyJob(job(), deps({ pace: async () => void (conv().ai_paused_until = '2026-09-29T15:30:00Z') }));
    expect(sent).toEqual([]);
    expect(db.table('ai_handoffs')[0]).toMatchObject({ notified: false, reason: 'Sem informação' });
    expect(conv().ai_paused_until).toBe('infinity');
  });

  it('D5: a transient read error in the last-moment check is thrown (retried), not treated as "stop"', async () => {
    const client = db.client();
    let contactReads = 0;
    const flaky = {
      rpc: client.rpc,
      from: (t: string) => {
        const q = client.from(t) as unknown as { select: (c: string) => unknown };
        if (t !== 'contacts') return q;
        const select = q.select.bind(q);
        q.select = (c: string) => {
          // 1st read = job start; 2nd = the last-moment check
          if (c === 'opted_out_at, anonymized_at' && ++contactReads === 1) {
            return { eq: () => ({ maybeSingle: async () => ({ data: null, error: { message: 'connection reset' } }) }) };
          }
          return select(c);
        };
        return q;
      },
    } as unknown as SupabaseClient;
    await expect(runAutoReplyJob(job(), deps({ db: flaky }))).rejects.toThrow('last-moment read failed');
    expect(sent).toEqual([]);
    expect(jobRow()).toMatchObject({ status: 'running', sent_parts: 0 });
  });

  it('D1: business hours are trusted ground; "Até amanhã" is a goodbye', async () => {
    agentRow().business_hours = { ...DEFAULT_BUSINESS_HOURS, enabled: true, start: '08:00', end: '23:59', days: [0, 1, 2, 3, 4, 5, 6] };
    db.table('ai_settings')[0].instructions = 'Seja simpático.';
    modelText = reply('Atendemos das 8h às 23h59. Até amanhã!');
    await expect(runAutoReplyJob(job(), deps())).resolves.toBe('replied');
    modelText = reply('Atendemos até as 22h.');
    Object.assign(jobRow(), { status: 'running', reply_parts: null, sent_parts: 0 });
    await expect(runAutoReplyJob(job({ id: 'job-1' }), deps())).resolves.toBe('handoff');
  });
});

describe('reschedule / requeue', () => {
  it('outside business hours → rescheduled, attempt not counted', async () => {
    agentRow().business_hours = { ...DEFAULT_BUSINESS_HOURS, enabled: true, start: '13:00' };
    await expect(runAutoReplyJob(job({ attempts: 1 }), deps())).resolves.toBe('rescheduled');
    expect(jobRow()).toMatchObject({ status: 'queued', run_after: '2026-09-29T16:00:00.000Z', attempts: 0 });
  });

  it('a newer queued job exists (unique index) → messages merged into it, nothing dropped', async () => {
    agentRow().business_hours = { ...DEFAULT_BUSINESS_HOURS, enabled: true, start: '13:00' };
    db.seed('ai_reply_jobs', [{ id: 'job-2', conversation_id: 'conv', status: 'queued', inbound_message_ids: ['m9'] }]);
    const client = db.client();
    const unique = {
      rpc: client.rpc,
      from: (t: string) => {
        const q = client.from(t) as unknown as { update: (p: Row) => unknown };
        if (t !== 'ai_reply_jobs') return q;
        const update = q.update.bind(q);
        q.update = (p: Row) =>
          p.status === 'queued' && db.table('ai_reply_jobs').some((j) => j.status === 'queued')
            ? { eq: async () => ({ error: { code: '23505', message: 'duplicate' } }) }
            : update(p);
        return q;
      },
    } as unknown as SupabaseClient;
    await runAutoReplyJob(job(), deps({ db: unique }));
    expect(jobRow()).toMatchObject({ status: 'skipped', skip_reason: 'merged' });
    expect(jobRow('job-2').inbound_message_ids).toEqual(['m1', 'm9']);
  });
});

describe('drain', () => {
  it('failed job → requeued with back-off', async () => {
    db.rpcHandler = (fn) => (fn === 'ai_reply_claim' ? { data: [job()], error: null } : { data: null, error: null });
    const r = await drainAutoReplies(
      deps({
        hasAiModule: async () => {
          throw new Error('db down');
        },
      }),
    );
    expect(r).toMatchObject({ claimed: 1, failed: 1 });
    expect(jobRow()).toMatchObject({ status: 'queued', last_error: 'db down', run_after: '2026-09-29T15:00:30.000Z' });
  });

  it('last attempt fails → failed + silent hand-over card', async () => {
    db.rpcHandler = () => ({ data: [job({ attempts: 3 })], error: null });
    let calls = 0;
    await drainAutoReplies(
      deps({
        hasAiModule: async () => {
          if (++calls === 1) throw new Error('db down');
          return true;
        },
      }),
    );
    expect(jobRow()).toMatchObject({ status: 'failed' });
    expect(db.table('ai_handoffs')[0]).toMatchObject({ notified: false });
    expect(sent).toEqual([]);
  });

  it('claims only the free concurrency slots', async () => {
    const limits: number[] = [];
    db.rpcHandler = (_fn, args) => {
      limits.push(args.p_limit as number);
      return { data: Array.from({ length: args.p_limit as number }, (_, i) => job({ id: `j${i}` })), error: null };
    };
    expect(await claimAutoReplies(deps())).toHaveLength(10);
    expect(await claimAutoReplies(deps())).toHaveLength(0);
    expect(limits).toEqual([10]);
  });
});

describe('enqueueAutoReplyIfEligible', () => {
  it('queues through the RPC only for an auto agent, AI on, eligible conversation', async () => {
    const calls: unknown[] = [];
    db.rpcHandler = (fn, args) => {
      calls.push([fn, args]);
      return { data: 'job', error: null };
    };
    const input = { accountId: 'acc', conversation: conv(), contact: db.table('contacts')[0], messageIds: ['m1'], now: NOW };
    expect(await enqueueAutoReplyIfEligible(db.client(), input)).toBe(true);
    expect(calls).toEqual([
      [
        'ai_reply_enqueue',
        { p_account_id: 'acc', p_conversation_id: 'conv', p_contact_id: 'ct', p_agent_id: 'ag', p_message_ids: ['m1'], p_delay_seconds: 8 },
      ],
    ]);
    conv().ai_paused_until = 'infinity';
    expect(await enqueueAutoReplyIfEligible(db.client(), input)).toBe(false);
    conv().ai_paused_until = null;
    agentRow().mode = 'suggest';
    expect(await enqueueAutoReplyIfEligible(db.client(), input)).toBe(false);
    agentRow().mode = 'auto';
    db.table('ai_settings')[0].enabled = false;
    expect(await enqueueAutoReplyIfEligible(db.client(), input)).toBe(false);
    db.table('ai_settings')[0].enabled = true;
    h.module = false;
    expect(await enqueueAutoReplyIfEligible(db.client(), input)).toBe(false);
    expect(calls).toHaveLength(1);
  });
});

describe('skills (migration 080)', () => {
  const withActions = () =>
    JSON.stringify({
      reply: 'Olá! Abrimos às 8h.',
      handoff: false,
      reason: '',
      actions: [
        { skill: 'internal_note', text: 'Cliente quer saber o horário' },
        { skill: 'add_tag', tag: 'interessado' },
      ],
    });

  beforeEach(() => {
    db.seed('tags', [{ id: 'tg1', account_id: 'acc', name: 'Interessado' }]);
    modelText = withActions();
  });

  it('runs the actions of an agent that has the skills on, and still replies', async () => {
    agentRow().skills = ['internal_note', 'add_tag'];
    await expect(runAutoReplyJob(job(), deps())).resolves.toBe('replied');
    expect(sent).toEqual(['Olá! Abrimos às 8h.']);
    expect(db.table('contact_notes')).toMatchObject([
      { account_id: 'acc', contact_id: 'ct', user_id: 'owner', note_text: '[IA] Cliente quer saber o horário' },
    ]);
    expect(db.table('contact_tags')).toMatchObject([{ contact_id: 'ct', tag_id: 'tg1' }]);
    expect(db.table('ai_actions').map((a) => [a.seq, a.skill, a.status])).toEqual([
      [0, 'internal_note', 'ok'],
      [1, 'add_tag', 'ok'],
    ]);
  });

  it('ignores actions for skills that are off (the model cannot grant itself powers)', async () => {
    agentRow().skills = ['internal_note'];
    await runAutoReplyJob(job(), deps());
    expect(db.table('contact_notes')).toHaveLength(1);
    expect(db.table('contact_tags') ?? []).toHaveLength(0);
    expect(db.table('ai_actions').map((a) => a.skill)).toEqual(['internal_note']);
  });

  it('does nothing at all for an agent without skills', async () => {
    await runAutoReplyJob(job(), deps());
    expect(sent).toEqual(['Olá! Abrimos às 8h.']);
    expect(db.table('contact_notes') ?? []).toHaveLength(0);
    expect(db.table('ai_actions') ?? []).toHaveLength(0);
  });

  it('does not run actions when the reply is handed over', async () => {
    agentRow().skills = ['internal_note'];
    modelText = JSON.stringify({ reply: null, handoff: true, reason: 'sem info', actions: [{ skill: 'internal_note', text: 'x' }] });
    await expect(runAutoReplyJob(job(), deps())).resolves.toBe('handoff');
    expect(db.table('contact_notes') ?? []).toHaveLength(0);
  });
});

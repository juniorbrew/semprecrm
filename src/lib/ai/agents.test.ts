import { describe, expect, it } from 'vitest';

import {
  AGENT_ERRORS,
  agentInstructions,
  agentStatus,
  DEFAULT_BUSINESS_HOURS,
  parseAgentInput,
  resolveAgent,
  splitReply,
  suggestionInstructions,
} from './agents';
import { AGENT_PRESETS, agentPreset } from './agent-presets';
import { translateLiteral } from '@/lib/i18n';

const TAG = '11111111-1111-4111-8111-111111111111';
type Ch = 'official' | 'qr';

function agent(id: string, over: Partial<{ enabled: boolean; is_default: boolean; channels: Ch[]; tag_ids: string[] }> = {}) {
  return { id, enabled: true, is_default: false, channels: [] as Ch[], tag_ids: [] as string[], ...over };
}

describe('resolveAgent', () => {
  const agents = [
    agent('default', { is_default: true }),
    agent('qr', { channels: ['qr'] }),
    agent('vip', { tag_ids: [TAG] }),
    agent('vip-off', { tag_ids: [TAG], enabled: false }),
  ];

  it('tag match → number match → default → none', () => {
    expect(resolveAgent(agents, { channel: 'qr', tagIds: [TAG] })).toEqual({ agent: agents[2], match: 'tag' });
    expect(resolveAgent(agents, { channel: 'qr', tagIds: [] })).toEqual({ agent: agents[1], match: 'channel' });
    expect(resolveAgent(agents, { channel: 'official', tagIds: [] })).toEqual({ agent: agents[0], match: 'default' });
    expect(resolveAgent(agents.slice(1), { channel: 'official', tagIds: [] })).toBeNull();
    expect(resolveAgent([], { channel: 'qr', tagIds: [TAG] })).toBeNull();
  });

  it('skips disabled agents at every step (a disabled default too)', () => {
    expect(resolveAgent([agent('d', { is_default: true, enabled: false })], { channel: null, tagIds: [] })).toBeNull();
    expect(resolveAgent([agents[3]], { channel: null, tagIds: [TAG] })).toBeNull();
  });

  it('ties go to the first (oldest) agent', () => {
    const a = agent('a', { channels: ['official'] });
    const b = agent('b', { channels: ['official'] });
    expect(resolveAgent([a, b], { channel: 'official', tagIds: [] })?.agent).toBe(a);
  });
});

describe('parseAgentInput', () => {
  it('create requires name and instructions', () => {
    expect(parseAgentInput({ instructions: 'x' }, false)).toEqual({ ok: false, error: AGENT_ERRORS.name });
    expect(parseAgentInput({ name: 'Vendas' }, false)).toEqual({ ok: false, error: AGENT_ERRORS.instructions });
    expect(parseAgentInput({ name: '  Vendas  ', instructions: ' Seja breve ' }, false)).toEqual({
      ok: true,
      write: { name: 'Vendas', instructions: 'Seja breve' },
    });
  });

  it('edit validates only the present fields', () => {
    expect(parseAgentInput({ enabled: false }, true)).toEqual({ ok: true, write: { enabled: false } });
    expect(parseAgentInput({ enabled: 'no' }, true)).toEqual({ ok: false, error: AGENT_ERRORS.flag });
    expect(parseAgentInput({ tone: '', model: '' }, true)).toEqual({ ok: true, write: { tone: null, model: null } });
    expect(parseAgentInput({ model: 'bad model!' }, true)).toEqual({ ok: false, error: AGENT_ERRORS.model });
    expect(parseAgentInput({ instructions: 'x'.repeat(4001) }, true)).toEqual({ ok: false, error: AGENT_ERRORS.instructions });
    expect(parseAgentInput({ tone: 'x'.repeat(201) }, true)).toEqual({ ok: false, error: AGENT_ERRORS.tone });
    expect(parseAgentInput(null, true)).toEqual({ ok: false, error: AGENT_ERRORS.body });
  });

  it('channels and tag ids: known values only, de-duplicated', () => {
    expect(parseAgentInput({ channels: ['qr', 'qr', 'official'] }, true)).toEqual({
      ok: true,
      write: { channels: ['qr', 'official'] },
    });
    expect(parseAgentInput({ channels: ['sms'] }, true)).toEqual({ ok: false, error: AGENT_ERRORS.channels });
    expect(parseAgentInput({ tag_ids: [TAG, TAG] }, true)).toEqual({ ok: true, write: { tag_ids: [TAG] } });
    expect(parseAgentInput({ tag_ids: ['x'] }, true)).toEqual({ ok: false, error: AGENT_ERRORS.tags });
  });
});

describe('agentInstructions', () => {
  it('appends the tone when set', () => {
    expect(agentInstructions({ instructions: 'Seja breve.', tone: null })).toBe('Seja breve.');
    expect(agentInstructions({ instructions: 'Seja breve.', tone: 'formal' })).toBe('Seja breve.\n\nTom de voz: "formal"');
  });
});

describe('suggestionInstructions', () => {
  const agent = { name: 'VIP', instructions: 'Trate bem.', tone: null };
  it('general only, agent only, or general followed by the agent', () => {
    expect(suggestionInstructions('Geral.', null)).toBe('Geral.');
    expect(suggestionInstructions('  ', null)).toBeNull();
    expect(suggestionInstructions(null, agent)).toBe('Trate bem.');
    expect(suggestionInstructions('Geral.', agent)).toBe('Geral.\n\nInstruções do agente "VIP":\nTrate bem.');
  });
});

describe('parseAgentInput — automatic-reply settings (065)', () => {
  const bad = (body: Record<string, unknown>, error: string) =>
    expect(parseAgentInput(body, true)).toEqual({ ok: false, error });

  it('mode, pause, description', () => {
    expect(parseAgentInput({ mode: 'auto', description: ' Vende ' }, true)).toEqual({
      ok: true,
      write: { mode: 'auto', description: 'Vende' },
    });
    bad({ mode: 'robot' }, AGENT_ERRORS.mode);
    bad({ description: 'x'.repeat(301) }, AGENT_ERRORS.description);
    const paused = parseAgentInput({ paused: true }, true);
    expect(paused.ok && typeof paused.write.paused_at).toBe('string');
    expect(parseAgentInput({ paused: false }, true)).toEqual({ ok: true, write: { paused_at: null } });
    bad({ paused: 'yes' }, AGENT_ERRORS.flag);
    // paused_at itself is never taken from the client
    expect(parseAgentInput({ paused_at: '2020-01-01' }, true)).toEqual({ ok: true, write: {} });
  });

  it('business hours: shape, time zone, times and days', () => {
    const ok = parseAgentInput({ business_hours: { ...DEFAULT_BUSINESS_HOURS, days: [5, 1, 1] } }, true);
    expect(ok).toEqual({ ok: true, write: { business_hours: { ...DEFAULT_BUSINESS_HOURS, days: [1, 5] } } });
    for (const over of [
      { timezone: 'Mars/Olympus' },
      { timezone: '' },
      { start: '24:00' },
      { end: '8:00' },
      { days: [] },
      { days: [7] },
      { days: ['1'] },
      { enabled: 'yes' },
    ]) {
      bad({ business_hours: { ...DEFAULT_BUSINESS_HOURS, ...over } }, AGENT_ERRORS.businessHours);
    }
    bad({ business_hours: null }, AGENT_ERRORS.businessHours);
  });

  it('numeric limits', () => {
    expect(parseAgentInput({ max_chars_per_message: 80, max_messages_per_turn: 5, max_auto_replies_per_day: 200 }, true).ok).toBe(true);
    bad({ max_chars_per_message: 79 }, AGENT_ERRORS.maxChars);
    bad({ max_chars_per_message: 1001 }, AGENT_ERRORS.maxChars);
    bad({ max_chars_per_message: 400.5 }, AGENT_ERRORS.maxChars);
    bad({ max_messages_per_turn: 0 }, AGENT_ERRORS.maxMessages);
    bad({ max_messages_per_turn: 6 }, AGENT_ERRORS.maxMessages);
    bad({ max_auto_replies_per_day: 0 }, AGENT_ERRORS.maxReplies);
    bad({ max_auto_replies_per_day: null }, AGENT_ERRORS.maxReplies);
  });

  it('hand-over words: trimmed, de-duplicated case-insensitively, capped', () => {
    expect(parseAgentInput({ handoff_keywords: [' Atendente ', 'atendente', '', 'humano'] }, true)).toEqual({
      ok: true,
      write: { handoff_keywords: ['Atendente', 'humano'] },
    });
    bad({ handoff_keywords: Array.from({ length: 21 }, (_, i) => `k${i}`) }, AGENT_ERRORS.handoffKeywords);
    bad({ handoff_keywords: ['x'.repeat(61)] }, AGENT_ERRORS.handoffKeywords);
    bad({ handoff_keywords: 'atendente' }, AGENT_ERRORS.handoffKeywords);
    bad({ handoff_message: 'x'.repeat(501) }, AGENT_ERRORS.handoffMessage);
    expect(parseAgentInput({ handoff_message: '', ignore_groups: false }, true)).toEqual({
      ok: true,
      write: { handoff_message: null, ignore_groups: false },
    });
  });
});

describe('agentStatus', () => {
  it('disabled > paused (auto only) > active', () => {
    expect(agentStatus({ enabled: false, mode: 'auto', paused_at: 'x' })).toBe('disabled');
    expect(agentStatus({ enabled: true, mode: 'auto', paused_at: 'x' })).toBe('paused');
    expect(agentStatus({ enabled: true, mode: 'suggest', paused_at: 'x' })).toBe('active');
    expect(agentStatus({ enabled: true, mode: 'auto', paused_at: null })).toBe('active');
  });
});

describe('splitReply', () => {
  it('one message per paragraph; long paragraphs cut at sentence ends', () => {
    expect(splitReply('Oi!\n\nTudo bem?', 400, 3)).toEqual(['Oi!', 'Tudo bem?']);
    const long = 'Primeira frase aqui. Segunda frase aqui. Terceira frase aqui.';
    expect(splitReply(long, 45, 5)).toEqual(['Primeira frase aqui. Segunda frase aqui.', 'Terceira frase aqui.']);
    for (const p of splitReply(long, 45, 5)) expect(p.length).toBeLessThanOrEqual(45);
  });

  it('never more than maxParts: the rest goes into the last message', () => {
    expect(splitReply('a\n\nb\n\nc\n\nd', 400, 2)).toEqual(['a', 'b\n\nc\n\nd']);
    expect(splitReply('  ', 400, 3)).toEqual([]);
  });
});

describe('AGENT_PRESETS', () => {
  it('every template except "blank" is a valid agent with pt-BR copy', () => {
    for (const p of AGENT_PRESETS.filter((x) => x.id !== 'blank')) {
      const parsed = parseAgentInput(
        { name: p.name, description: p.description, tone: p.tone, instructions: p.instructions },
        false,
      );
      expect(parsed.ok, p.id).toBe(true);
      expect(p.instructions).toMatch(/Nunca|Não invente/);
    }
    expect(AGENT_PRESETS.map((p) => p.id)).toEqual(['sales', 'support', 'triage', 'finance', 'general', 'blank']);
  });

  it('sales never invents prices', () => {
    expect(AGENT_PRESETS[0].instructions).toContain('Nunca invente preços');
  });

  it('support: step by step, confirms it worked and asks to close', () => {
    const { name, instructions } = agentPreset('support');
    expect(name).toBe('Suporte');
    expect(instructions).toContain('passos curtos e numerados');
    expect(instructions).toContain('pergunte se o problema foi resolvido');
    expect(instructions).toContain('encerrar o atendimento');
    expect(instructions).toContain('Nunca prometa prazos, trocas, reembolsos');
  });

  it('triage collects the missing details, never solves and hands over with a briefing', () => {
    const { name, instructions } = agentPreset('triage');
    expect(name).toBe('Triagem');
    for (const need of ['produto', 'mensagem de erro', 'número do pedido ou da nota fiscal']) expect(instructions).toContain(need);
    expect(instructions).toContain('Nunca tente resolver');
    expect(instructions).toContain('resumo curto');
    expect(instructions).toContain('no máximo três perguntas');
  });

  it('finance uses the knowledge base, never promises refunds or discounts and hands over disputes', () => {
    const { name, instructions } = agentPreset('finance');
    expect(name).toBe('Financeiro');
    expect(instructions).toContain('base de conhecimento');
    expect(instructions).toMatch(/Nunca prometa, confirme nem sugira reembolso, estorno, desconto/);
    expect(instructions).toContain('contestar uma cobrança');
    expect(instructions).toContain('Passe para uma pessoa do time');
    expect(instructions).toContain('Não peça CPF ou CNPJ');
  });

  it('every template fits the limits with room to spare, and is translated for the picker', () => {
    for (const p of AGENT_PRESETS) {
      expect(p.instructions.length, p.id).toBeLessThanOrEqual(3500);
      expect(translateLiteral(p.label, 'pt-BR'), p.label).not.toBe(p.label === 'Blank' ? '' : p.label);
      expect(translateLiteral(p.summary, 'pt-BR'), p.summary).not.toBe(p.summary);
    }
  });

  it('"blank" needs the user to write name and instructions', () => {
    const blank = AGENT_PRESETS.find((p) => p.id === 'blank')!;
    expect(parseAgentInput({ name: blank.name, instructions: blank.instructions }, false).ok).toBe(false);
  });
});

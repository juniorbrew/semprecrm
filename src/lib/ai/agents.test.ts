import { describe, expect, it } from 'vitest';

import { AGENT_ERRORS, agentInstructions, parseAgentInput, resolveAgent } from './agents';

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
    expect(agentInstructions({ instructions: 'Seja breve.', tone: 'formal' })).toBe('Seja breve.\n\nTom de voz: formal');
  });
});

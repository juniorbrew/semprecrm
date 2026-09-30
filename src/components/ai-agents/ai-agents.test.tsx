import { describe, expect, it, vi } from 'vitest';
import { renderToString } from 'react-dom/server';

import {
  AGENT_DEFAULTS,
  DEFAULT_BUSINESS_HOURS,
  DEFAULT_HANDOFF_KEYWORDS,
  DEFAULT_HANDOFF_MESSAGE,
  type AiAgent,
} from '@/lib/ai/agents';
import { AgentCard, AgentStatusBadge } from './agent-card';
import { AgentConfigForm, draftErrors, draftFromAgent } from './agent-config-form';
import { AgentOperationBar } from './agent-operation-bar';
import { AgentTestResultView } from './agent-test-panel';
import { AgentsList } from './agents-list';

// Rendered to a string: markup + pt-BR copy (the language hook falls
// back to the default catalogue). Effects never run.
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => {
    throw new Error('createClient must only be called from effects/handlers');
  },
}));

const TAG = '11111111-1111-4111-8111-111111111111';

const base: AiAgent = {
  id: 'ag-1',
  name: 'Vendas',
  description: 'Qualifica e agenda demonstrações.',
  instructions: 'Seja consultivo.',
  tone: 'próximo',
  model: null,
  knowledge_enabled: true,
  is_default: true,
  enabled: true,
  channels: ['official'],
  tag_ids: [TAG],
  ...AGENT_DEFAULTS,
  paused_at: null,
  business_hours: DEFAULT_BUSINESS_HOURS,
  handoff_keywords: DEFAULT_HANDOFF_KEYWORDS,
  handoff_message: DEFAULT_HANDOFF_MESSAGE,
  created_at: '2026-09-29T00:00:00Z',
};
const tags = [{ id: TAG, name: 'VIP', color: '#f00' }];

describe('AgentStatusBadge', () => {
  it('pt-BR labels', () => {
    expect(renderToString(<AgentStatusBadge status="active" />)).toContain('Ativo');
    expect(renderToString(<AgentStatusBadge status="paused" />)).toContain('Pausado');
    expect(renderToString(<AgentStatusBadge status="disabled" />)).toContain('Desativado');
  });
});

describe('AgentCard', () => {
  it('name, model in effect, status, default, mode, description, chips and edit link', () => {
    const html = renderToString(<AgentCard agent={base} accountModel="gpt-4.1-mini" tags={tags} />);
    for (const s of ['Vendas', 'gpt-4.1-mini', 'Ativo', 'Padrão', 'Sugestão', 'Qualifica e agenda', 'WhatsApp oficial', 'VIP</span>', 'Editar']) {
      expect(html).toContain(s);
    }
    expect(html).toContain('href="/ai/agents/ag-1"');
  });

  it('own model wins; paused automatic agent', () => {
    const html = renderToString(
      <AgentCard agent={{ ...base, model: 'gpt-4.1', mode: 'auto', paused_at: 'x', is_default: false }} accountModel="gpt-4.1-mini" tags={[]} />,
    );
    expect(html).toContain('gpt-4.1<');
    expect(html).toContain('Pausado');
    expect(html).toContain('Automático');
    expect(html).not.toContain('Padrão');
  });
});

describe('AgentsList', () => {
  it('empty state with CTA for admins only', () => {
    const admin = renderToString(<AgentsList agents={[]} accountModel={null} tags={[]} canEdit onNew={() => {}} />);
    expect(admin).toContain('Nenhum agente de IA ainda');
    expect(admin).toContain('Criar primeiro agente');
    const agent = renderToString(<AgentsList agents={[]} accountModel={null} tags={[]} canEdit={false} onNew={() => {}} />);
    expect(agent).not.toContain('Criar primeiro agente');
  });

  it('search, status filter and one card per agent', () => {
    const html = renderToString(
      <AgentsList agents={[base, { ...base, id: 'ag-2', name: 'Suporte', enabled: false }]} accountModel={null} tags={tags} canEdit onNew={() => {}} />,
    );
    expect(html).toContain('Buscar agentes');
    for (const s of ['Todas as situações', 'Ativo', 'Pausado', 'Desativado', 'Vendas', 'Suporte']) expect(html).toContain(s);
    expect(html.match(/<li/g)).toHaveLength(2);
  });
});

describe('AgentOperationBar', () => {
  it('suggest mode: help line, no pause button, no automatic notice', () => {
    const html = renderToString(<AgentOperationBar agent={base} canEdit busy={false} onPatch={() => {}} onDelete={() => {}} />);
    expect(html).toContain('Sugestão (o atendente revisa)');
    expect(html).toContain('um atendente revisa e envia');
    expect(html).not.toContain('Pausar automático');
    expect(html).not.toContain('próxima atualização');
  });

  it('automatic mode: pause / resume, no "next update" notice any more', () => {
    const running = renderToString(
      <AgentOperationBar agent={{ ...base, mode: 'auto' }} canEdit busy={false} onPatch={() => {}} onDelete={() => {}} />,
    );
    expect(running).toContain('Pausar automático');
    expect(running).not.toContain('próxima atualização');
    expect(running).toContain('responde sozinho aos clientes');
    const paused = renderToString(
      <AgentOperationBar agent={{ ...base, mode: 'auto', paused_at: 'x' }} canEdit busy={false} onPatch={() => {}} onDelete={() => {}} />,
    );
    expect(paused).toContain('Retomar automático');
    expect(paused).toContain('pausadas');
  });
});

describe('AgentConfigForm', () => {
  const form = (canEdit: boolean) =>
    renderToString(
      <AgentConfigForm
        agent={base}
        provider="openai"
        accountModel="gpt-4.1-mini"
        knowledgeItems={3}
        tags={tags}
        canEdit={canEdit}
        onSave={async () => {}}
      />,
    );

  it('renders every section', () => {
    const html = form(true);
    for (const s of [
      'Quem é este agente',
      'A inteligência que ele usa',
      'Onde ele atende',
      'As instruções dele',
      'O que ele consulta',
      'Quando ele entra em ação',
      'Estilo de resposta',
      'Passar para uma pessoa',
      'Freios de segurança',
      'Confere antes de enviar',
    ]) {
      expect(html).toContain(s);
    }
    expect(html).toContain('OpenAI');
    expect(html).toContain('placeholder="gpt-4.1-mini"');
    expect(html).toMatch(/16(<!-- -->)?\/(<!-- -->)?4000/);
    expect(html).toContain('sempre valem primeiro');
    expect(html).toContain('itens ativos na base de conhecimento');
    expect(html).toContain('America/Sao_Paulo');
    expect(html).toContain('falar com atendente');
    expect(html).toContain('Isto não se desliga.');
    expect(html.match(/Isto não se desliga\./g)).toHaveLength(1);
    expect(html).toContain('Salvar');
  });

  it('read-only for non-admins: no Save', () => {
    const html = form(false);
    expect(html).not.toContain('>Salvar<');
    expect(html).toContain('readOnly=""');
  });

  it('validation uses the API rules, per field', () => {
    const d = draftFromAgent(base);
    expect(draftErrors(d)).toEqual({});
    const errs = draftErrors({
      ...d,
      name: ' ',
      max_chars_per_message: 5,
      max_messages_per_turn: Number.NaN,
      business_hours: { ...d.business_hours, days: [] },
    });
    expect(Object.keys(errs).sort()).toEqual(['business_hours', 'max_chars_per_message', 'max_messages_per_turn', 'name']);
  });
});

describe('AgentTestResultView', () => {
  it('bubbles, stats and knowledge used', () => {
    const html = renderToString(
      <AgentTestResultView
        result={{
          text: 'a\n\nb',
          parts: ['Olá!', 'Posso ajudar?'],
          model: 'gpt-4.1-mini',
          input_tokens: 1200,
          output_tokens: 40,
          cost_cents: 0.05,
          latency_ms: 850,
          knowledge: [{ title: 'Horários' }],
        }}
      />,
    );
    expect(html).toContain('Mensagem que SERIA enviada');
    expect(html).toContain('Olá!');
    expect(html).toContain('Posso ajudar?');
    expect(html).toContain('Horários');
    expect(html).toContain('850 ms');
    expect(html).toContain('Latência');
  });
});

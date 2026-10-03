// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import {
  AGENT_DEFAULTS,
  DEFAULT_BUSINESS_HOURS,
  DEFAULT_HANDOFF_KEYWORDS,
  DEFAULT_HANDOFF_MESSAGE,
  type AiAgent,
} from '@/lib/ai/agents';
import { AgentsList } from './agents-list';

const base: AiAgent = {
  id: 'ag-1',
  name: 'Vendas',
  description: null,
  instructions: '',
  tone: '',
  model: null,
  knowledge_enabled: false,
  is_default: false,
  enabled: true,
  channels: ['official'],
  tag_ids: [],
  ...AGENT_DEFAULTS,
  paused_at: null,
  business_hours: DEFAULT_BUSINESS_HOURS,
  handoff_keywords: DEFAULT_HANDOFF_KEYWORDS,
  handoff_message: DEFAULT_HANDOFF_MESSAGE,
  created_at: '2026-09-29T00:00:00Z',
};

afterEach(cleanup);

describe('AgentsList status pills', () => {
  it('filters by status and marks the active pill as pressed', () => {
    render(
      <AgentsList
        agents={[base, { ...base, id: 'ag-2', name: 'Suporte', enabled: false }]}
        accountModel={null}
        tags={[]}
        canEdit
        onNew={() => {}}
      />,
    );
    const all = screen.getByRole('button', { name: 'Todas as situações' });
    expect(all.getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(screen.getByRole('button', { name: 'Desativado' }));
    expect(screen.getByRole('button', { name: 'Desativado' }).getAttribute('aria-pressed')).toBe('true');
    expect(all.getAttribute('aria-pressed')).toBe('false');
    expect(screen.queryByText('Vendas')).toBeNull();
    expect(screen.getByText('Suporte')).toBeTruthy();
  });
});

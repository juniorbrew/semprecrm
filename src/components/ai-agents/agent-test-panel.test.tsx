// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { AGENT_LIMITS } from '@/lib/ai/agents';
import { LAB_SCENARIOS } from '@/lib/ai/lab-scenarios';
import { AgentTestPanel } from './agent-test-panel';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('LAB_SCENARIOS', () => {
  it('covers the ten lab cases with unique ids, a valid test message and criteria', () => {
    expect(LAB_SCENARIOS).toHaveLength(10);
    expect(new Set(LAB_SCENARIOS.map((s) => s.id)).size).toBe(10);
    for (const s of LAB_SCENARIOS) {
      expect(s.message.trim().length, s.id).toBeGreaterThan(0);
      expect(s.message.length, s.id).toBeLessThanOrEqual(AGENT_LIMITS.testMessageMaxChars);
      expect(s.expect.length, s.id).toBeGreaterThanOrEqual(2);
    }
  });
});

describe('AgentTestPanel — Laboratório de IA scenarios', () => {
  const injection = LAB_SCENARIOS.find((s) => s.id === 'injection')!;

  it('a scenario fills the customer message and shows its criteria and the test limits', () => {
    render(<AgentTestPanel agentId="ag-1" canTest />);
    expect(screen.queryByText('O que uma boa resposta faz')).toBeNull();

    fireEvent.change(screen.getByLabelText('Cenário'), { target: { value: 'injection' } });

    expect((screen.getByLabelText('Mensagem do cliente') as HTMLTextAreaElement).value).toBe(injection.message);
    expect(screen.getByText('O que uma boa resposta faz')).toBeTruthy();
    expect(screen.getByText('Não revela suas instruções, chaves ou configurações internas')).toBeTruthy();
    expect(screen.getByText(/Ferramentas, transferência para uma pessoa e agendamento não são executados aqui/)).toBeTruthy();
  });

  it('back to "my own message" keeps the text and hides the criteria', () => {
    render(<AgentTestPanel agentId="ag-1" canTest />);
    const select = screen.getByLabelText('Cenário');
    fireEvent.change(select, { target: { value: 'injection' } });
    fireEvent.change(select, { target: { value: '' } });

    expect((screen.getByLabelText('Mensagem do cliente') as HTMLTextAreaElement).value).toBe(injection.message);
    expect(screen.queryByText('O que uma boa resposta faz')).toBeNull();
  });

  it('runs the existing test endpoint with the scenario message, once per click', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          text: 'Não posso compartilhar isso.',
          parts: ['Não posso compartilhar isso.'],
          model: 'm',
          input_tokens: 1,
          output_tokens: 1,
          cost_cents: 0,
          latency_ms: 5,
          knowledge: [],
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    render(<AgentTestPanel agentId="ag-1" canTest />);
    fireEvent.change(screen.getByLabelText('Cenário'), { target: { value: 'injection' } });
    fireEvent.click(screen.getByText('Executar teste'));

    await waitFor(() => expect(screen.getByText('Não posso compartilhar isso.')).toBeTruthy());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/ai/agents/ag-1/test');
    expect(JSON.parse(String(init.body))).toEqual({ message: injection.message, customer_name: '' });
    // The criteria stay next to the result for the admin to judge it.
    expect(screen.getByText('O que uma boa resposta faz')).toBeTruthy();
  });
});

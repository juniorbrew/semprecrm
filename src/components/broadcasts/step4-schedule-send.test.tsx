// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { MessageTemplate } from '@/types';

const h = vi.hoisted(() => ({ state: {} as Record<string, unknown> }));

vi.mock('@/hooks/use-audience-estimate', () => ({ useAudienceEstimate: () => h.state }));
vi.mock('@/hooks/use-language', async () => {
  const { translateLiteral } = await import('@/lib/i18n');
  return { useLanguage: () => ({ t: (k: string) => translateLiteral(k, 'pt-BR'), language: 'pt-BR' }) };
});

import { Step4ScheduleSend } from './step4-schedule-send';

afterEach(cleanup);

function renderStep() {
  render(
    <Step4ScheduleSend
      name="Promo"
      onNameChange={() => undefined}
      template={{ id: 't', name: 'promo', language: 'pt_BR' } as MessageTemplate}
      audience={{ type: 'all' }}
      onSend={() => undefined}
      onBack={() => undefined}
      isProcessing={false}
      progress={0}
    />,
  );
}

const sendButton = () => screen.getByRole('button', { name: /Enviar disparo/ });

describe('Step4ScheduleSend reach', () => {
  it('a failed estimate shows "—" and an error, never 0, and blocks the send', () => {
    h.state = { estimate: null, loading: false, failed: true };
    renderStep();
    expect(screen.getByText('—')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toBe('Não foi possível calcular o alcance. Tente de novo.');
    expect(screen.queryByText('0')).toBeNull();
    expect((sendButton() as HTMLButtonElement).disabled).toBe(true);
  });

  it('a valid estimate shows the eligible count and enables the send', () => {
    h.state = {
      estimate: {
        breakdown: { selected: 9, duplicate: 0, excludedByTag: 2, optedOut: 1, noPhone: 0, suppressed: 0, eligible: 6 },
        suppressionChecked: true,
        capped: false,
      },
      loading: false,
      failed: false,
    };
    renderStep();
    expect(screen.getByText('6')).toBeTruthy();
    expect(screen.getByText('9 selecionados · 2 excluídos por etiqueta · 1 descadastrado')).toBeTruthy();
    expect((sendButton() as HTMLButtonElement).disabled).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';

import { AiHandoffCard, AiPauseButton, type AiAutoState } from './ai-auto-controls';

const handoff = {
  id: 'h1',
  reason: 'O cliente pediu para falar com uma pessoa',
  customer_wants: 'Cancelar o pedido',
  last_customer_words: 'quero falar com atendente',
  notified: true,
  created_at: '2026-09-29T10:00:00Z',
};

const state = (over: Partial<AiAutoState> = {}): AiAutoState => ({
  applies: true,
  agent: { id: 'a', name: 'Bia', paused: false },
  paused: false,
  paused_until: null,
  handling: true,
  handoff: null,
  ...over,
});

describe('AiHandoffCard', () => {
  it('shows why, the last words, notified ✓ and the claim button', () => {
    const html = renderToString(<AiHandoffCard handoff={handoff} canClaim onClaim={() => {}} />);
    for (const s of ['Por que a IA passou para você', 'O cliente quer', 'Cancelar o pedido', 'Últimas palavras do cliente', 'Motivo', 'Cliente avisado', 'Sim', 'Assumir e responder']) {
      expect(html).toContain(s);
    }
  });

  it('warns when the customer was not notified; no button without claim rights', () => {
    const html = renderToString(<AiHandoffCard handoff={{ ...handoff, notified: false }} canClaim={false} onClaim={() => {}} />);
    expect(html).toContain('o aviso não pôde ser enviado');
    expect(html).not.toContain('Assumir e responder');
  });
});

describe('AiPauseButton', () => {
  it('pause / resume label, hidden when no automatic agent applies, disabled for viewers', () => {
    expect(renderToString(<AiPauseButton conversationId="c" state={state()} canWrite onChanged={() => {}} />)).toContain('Pausar IA');
    expect(renderToString(<AiPauseButton conversationId="c" state={state({ paused: true })} canWrite onChanged={() => {}} />)).toContain('Retomar IA');
    expect(renderToString(<AiPauseButton conversationId="c" state={state({ applies: false })} canWrite onChanged={() => {}} />)).toBe('');
    expect(renderToString(<AiPauseButton conversationId="c" state={state()} canWrite={false} onChanged={() => {}} />)).toContain('disabled');
  });
});

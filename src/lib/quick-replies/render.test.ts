import { describe, expect, it } from 'vitest';

import {
  QUICK_REPLY_VARIABLES,
  renderQuickReply,
  resolveQuickReplyVariable,
  variableToken,
} from './render';

const ctx = {
  contactName: 'Ana Paula Souza',
  agentName: 'Carlos Lima',
  companyName: 'Sempre Tech',
};

describe('renderQuickReply', () => {
  it('replaces every supported variable', () => {
    expect(
      renderQuickReply(
        'Olá {{contato.nome}}! Aqui é {{atendente.nome}} da {{empresa}}. Posso te chamar de {{contato.primeiro_nome}}?',
        ctx,
      ),
    ).toBe('Olá Ana Paula Souza! Aqui é Carlos Lima da Sempre Tech. Posso te chamar de Ana?');
  });

  it('tolerates spaces inside the braces', () => {
    expect(renderQuickReply('Oi {{ contato.primeiro_nome }}', ctx)).toBe('Oi Ana');
  });

  it('renders unknown variables as empty', () => {
    expect(renderQuickReply('Oi {{cliente.nome}}!', ctx)).toBe('Oi !');
  });

  it('renders missing values as empty and collapses double spaces', () => {
    expect(renderQuickReply('Olá {{contato.nome}} tudo bem?', {})).toBe('Olá tudo bem?');
    expect(renderQuickReply('Olá {{contato.nome}}', { contactName: null })).toBe('Olá ');
  });

  it('leaves text without variables untouched (including single braces)', () => {
    expect(renderQuickReply('Preço: {valor} — 50% off', ctx)).toBe('Preço: {valor} — 50% off');
  });

  it('keeps newlines', () => {
    expect(renderQuickReply('Oi {{contato.primeiro_nome}},\n\nTudo bem?', ctx)).toBe(
      'Oi Ana,\n\nTudo bem?',
    );
  });

  it('first name of a single-word or padded name', () => {
    expect(resolveQuickReplyVariable('contato.primeiro_nome', { contactName: '  Bruno ' })).toBe(
      'Bruno',
    );
    expect(resolveQuickReplyVariable('contato.primeiro_nome', { contactName: '' })).toBe('');
  });
});

describe('variableToken', () => {
  it('wraps every offered variable in double braces', () => {
    for (const name of QUICK_REPLY_VARIABLES) {
      expect(variableToken(name)).toBe(`{{${name}}}`);
    }
  });
});

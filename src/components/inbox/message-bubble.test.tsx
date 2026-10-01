import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';

import type { Message } from '@/types';
import { translateLiteral } from '@/lib/i18n';
import { MessageBubble } from './message-bubble';
import { senderLabelFor } from './sender-label';

const ME = 'user-me';
const names: Record<string, string> = { 'user-ana': 'Ana Souza' };
const ctx = { currentUserId: ME, nameFor: (id: string) => names[id] };

function msg(extra: Partial<Message>): Message {
  return {
    id: 'm-1',
    conversation_id: 'conv-1',
    sender_type: 'agent',
    content_type: 'text',
    content_text: 'Olá!',
    status: 'sent',
    created_at: '2026-09-28T12:00:00.000Z',
    ...extra,
  } as Message;
}

describe('senderLabelFor', () => {
  it('customer messages have no label', () => {
    expect(senderLabelFor(msg({ sender_type: 'customer' }), ctx)).toBeNull();
  });

  it('the current user reads "You", a teammate by name, unknown → "Agent"', () => {
    expect(senderLabelFor(msg({ sender_id: ME }), ctx)).toMatchObject({ kind: 'you', text: 'You', translate: true });
    expect(senderLabelFor(msg({ sender_id: 'user-ana' }), ctx)).toMatchObject({
      kind: 'agent',
      text: 'Ana Souza',
      translate: false,
    });
    expect(senderLabelFor(msg({ sender_id: 'user-gone' }), ctx)).toMatchObject({ text: 'Agent' });
    expect(senderLabelFor(msg({}), ctx)).toMatchObject({ text: 'Agent' });
  });

  it('origin wins: phone, automation, flow (Bot), system', () => {
    expect(senderLabelFor(msg({ origin: 'phone' }), ctx)).toMatchObject({ kind: 'phone', text: 'Mobile phone' });
    expect(senderLabelFor(msg({ sender_type: 'bot', origin: 'automation' }), ctx)).toMatchObject({ text: 'Automation' });
    expect(senderLabelFor(msg({ sender_type: 'bot', origin: 'ai' }), ctx)).toMatchObject({ kind: 'ai', text: 'AI' });
    expect(senderLabelFor(msg({ sender_type: 'bot', origin: 'flow' }), ctx)).toMatchObject({ text: 'Bot' });
    expect(senderLabelFor(msg({ origin: 'system' }), ctx)).toMatchObject({ text: 'System' });
    expect(senderLabelFor(msg({ sender_type: 'bot', origin: 'csat' }), ctx)).toMatchObject({ kind: 'survey', text: 'Survey' });
    expect(translateLiteral('Survey', 'pt-BR')).toBe('Pesquisa');
  });

  it('legacy bot rows without origin read "Automation"', () => {
    expect(senderLabelFor(msg({ sender_type: 'bot' }), ctx)).toMatchObject({ kind: 'automation' });
  });

  it('every translatable label has a pt-BR entry', () => {
    expect(translateLiteral('Mobile phone', 'pt-BR')).toBe('Celular');
    expect(translateLiteral('You', 'pt-BR')).toBe('Você');
    expect(translateLiteral('Automation', 'pt-BR')).toBe('Automação');
    expect(translateLiteral('System', 'pt-BR')).toBe('Sistema');
    expect(translateLiteral('Agent', 'pt-BR')).toBe('Agente');
    expect(translateLiteral('Deleted by customer', 'pt-BR')).toBe('Apagada pelo cliente');
    expect(translateLiteral('Deleted from the phone', 'pt-BR')).toBe('Apagada pelo celular');
    expect(translateLiteral('Sent from the phone or WhatsApp Web', 'pt-BR')).toContain('celular');
  });
});

describe('MessageBubble — sender label', () => {
  it('renders the label next to the time on outbound bubbles', () => {
    const m = msg({ origin: 'phone' });
    const html = renderToString(<MessageBubble message={m} senderLabel={senderLabelFor(m, ctx)} />);
    expect(html).toContain('data-sender-kind="phone"');
    expect(html).toContain('>Mobile phone<');
    expect(html).toContain('title="Sent from the phone or WhatsApp Web"');
  });

  it("a teammate's name is never run through the translator", () => {
    const m = msg({ sender_id: 'user-ana' });
    const html = renderToString(<MessageBubble message={m} senderLabel={senderLabelFor(m, ctx)} />);
    expect(html).toMatch(/data-no-translate="true"[^>]*>Ana Souza</);
  });

  it('never labels customer bubbles', () => {
    const m = msg({ sender_type: 'customer' });
    const html = renderToString(
      <MessageBubble message={m} senderLabel={{ kind: 'you', text: 'You', translate: true }} />,
    );
    expect(html).not.toContain('data-sender-kind');
  });
});

describe('MessageBubble — deleted for everyone', () => {
  it('keeps the text, struck through, with "Deleted by customer"', () => {
    const m = msg({
      sender_type: 'customer',
      content_text: 'mensagem apagada',
      revoked_at: '2026-09-28T12:01:00.000Z',
      revoked_by: 'customer',
    });
    const html = renderToString(<MessageBubble message={m} />);
    expect(html).toContain('mensagem apagada');
    expect(html).toContain('line-through');
    expect(html).toContain('>Deleted by customer<');
  });

  it('a message deleted from our phone says so', () => {
    const m = msg({ origin: 'phone', revoked_at: '2026-09-28T12:01:00.000Z', revoked_by: 'phone' });
    expect(renderToString(<MessageBubble message={m} />)).toContain('>Deleted from the phone<');
  });

  it('a normal message is not struck through', () => {
    const html = renderToString(<MessageBubble message={msg({})} />);
    expect(html).not.toContain('line-through');
    expect(html).not.toContain('Deleted');
  });
});

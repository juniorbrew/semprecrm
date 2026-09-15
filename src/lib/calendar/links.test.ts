import { describe, expect, it } from 'vitest';

import { eventHref, eventLinks, linkHref, linkLabel, titleFromMessage } from './links';

const base = {
  contact_id: null,
  conversation_id: null,
  deal_id: null,
  task_id: null,
  chat_thread_id: null,
};

describe('linkHref', () => {
  it('routes each kind to its page with the id in the query', () => {
    expect(linkHref('contact', 'c1')).toBe('/contacts?contact=c1');
    expect(linkHref('conversation', 'v1')).toBe('/inbox?c=v1');
    expect(linkHref('deal', 'd1')).toBe('/pipelines?deal=d1');
    expect(linkHref('task', 't1')).toBe('/tasks?task=t1');
    expect(linkHref('chat_thread', 'x1')).toBe('/chat?t=x1');
    expect(linkHref('contact', 'a b')).toBe('/contacts?contact=a%20b');
    expect(eventHref('e/1')).toBe('/agenda?event=e%2F1');
  });
});

describe('eventLinks', () => {
  it('returns nothing for an unlinked event', () => {
    expect(eventLinks(base)).toEqual([]);
  });

  it('lists every link in display order with labels from the embeds', () => {
    const links = eventLinks({
      ...base,
      contact_id: 'c1',
      conversation_id: 'v1',
      deal_id: 'd1',
      task_id: 't1',
      chat_thread_id: 'x1',
      contact: { id: 'c1', name: 'Maria', phone: '+55', avatar_url: null },
      deal: { id: 'd1', title: 'Sofá 3 lugares', pipeline_id: 'p' },
      task: { id: 't1', title: 'Enviar orçamento' },
      chat_thread: { id: 'x1', kind: 'group', title: 'Vendas' },
    });
    expect(links.map((l) => l.kind)).toEqual(['contact', 'conversation', 'deal', 'task', 'chat_thread']);
    expect(links.map((l) => l.label)).toEqual([
      'Maria',
      'Conversation · Maria',
      'Sofá 3 lugares',
      'Enviar orçamento',
      'Vendas',
    ]);
    expect(links[0].href).toBe('/contacts?contact=c1');
  });

  it('falls back to the phone / generic labels when embeds are missing', () => {
    const e = {
      ...base,
      contact_id: 'c1',
      deal_id: 'd1',
      chat_thread_id: 'x1',
      contact: { id: 'c1', name: '  ', phone: '+5511', avatar_url: null },
    };
    expect(linkLabel(e, 'contact')).toBe('+5511');
    expect(linkLabel(e, 'deal')).toBe('Deal');
    expect(linkLabel({ ...e, chat_thread: { id: 'x1', kind: 'direct', title: null } }, 'chat_thread')).toBe(
      'Internal chat',
    );
  });
});

describe('titleFromMessage', () => {
  it('takes the first non-empty line, capped with an ellipsis', () => {
    expect(titleFromMessage('\n\n  Reunião amanhã às 10  \nsegunda linha')).toBe('Reunião amanhã às 10');
    expect(titleFromMessage('')).toBe('');
    expect(titleFromMessage('a'.repeat(100), 20)).toBe('a'.repeat(19) + '…');
  });
});

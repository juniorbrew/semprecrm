import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToString } from 'react-dom/server';
import type { Contact, Tag } from '@/types';
import {
  CONTACTS_COPY,
  ContactListRow,
  contactMetaLine,
  readContactsDensity,
  writeContactsDensity,
  type ContactListRowProps,
} from './contact-list-row';

const contact = (over: Partial<Contact> = {}): Contact =>
  ({
    id: 'k1',
    name: 'Marina Souza',
    phone: '5511999990000',
    email: 'marina@exemplo.com',
    company: 'Acme',
    created_at: '2026-09-30T10:00:00Z',
    ...over,
  }) as Contact;

const tag = (id: string, name: string): Tag =>
  ({ id, name, color: '#22c55e', user_id: 'u', created_at: '' }) as Tag;

const render = (c: Contact, extra: Partial<ContactListRowProps> = {}) =>
  renderToString(
    <table>
      <tbody>
        <ContactListRow
          contact={c}
          tags={[]}
          selected={false}
          compact={false}
          createdLabel="30 set. 2026"
          copy={CONTACTS_COPY['pt-BR']}
          onToggleSelect={() => {}}
          onOpen={() => {}}
          onOpenConversation={() => {}}
          onEdit={() => {}}
          onDelete={() => {}}
          {...extra}
        />
      </tbody>
    </table>,
  );

describe('contactMetaLine', () => {
  it('joins company and phone, skipping blanks', () => {
    expect(contactMetaLine({ company: 'Acme', phone: '55119' })).toBe('Acme · 55119');
    expect(contactMetaLine({ company: '  ', phone: '55119' })).toBe('55119');
    expect(contactMetaLine({ company: null, phone: '55119' })).toBe('55119');
  });
});

describe('ContactListRow', () => {
  it('shows name, meta line and an accessible open button', () => {
    const html = render(contact());
    expect(html).toContain('Marina Souza');
    expect(html).toContain('Acme · 5511999990000');
    expect(html).toContain('aria-label="Abrir Marina Souza"');
    expect(html).toContain('aria-label="Mais ações para Marina Souza"');
  });

  it('marks the selected row with the brand tint', () => {
    const html = render(contact(), { selected: true });
    expect(html).toContain('data-selected="true"');
    expect(html).toContain('bg-primary/10');
  });

  it('shows opted-out and anonymised as quiet text, and hides edit for anonymised', () => {
    expect(render(contact({ opted_out_at: '2026-09-01' }))).toContain('Descadastrado');
    const anon = render(contact({ anonymized_at: '2026-09-01' }));
    expect(anon).toContain('Anonimizado');
    expect(anon).not.toContain('title="Editar"');
  });

  it('caps tags at three with a +N', () => {
    const tags = ['a', 'b', 'c', 'd', 'e'].map((x) => tag(x, `Tag ${x}`));
    const html = render(contact(), { tags });
    expect(html).toContain('Tag c');
    expect(html).not.toContain('Tag d');
    expect(html).toContain('+<!-- -->2');
  });

  it('compact density uses the small avatar', () => {
    expect(render(contact(), { compact: true })).toContain('size-7');
    expect(render(contact())).toContain('size-9');
  });
});

describe('density preference', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('round-trips per user', () => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    });
    expect(readContactsDensity('u1')).toBe('comfortable');
    writeContactsDensity('u1', 'compact');
    expect(readContactsDensity('u1')).toBe('compact');
    expect(readContactsDensity('u2')).toBe('comfortable');
  });

  it('survives a throwing localStorage', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    });
    expect(readContactsDensity('u1')).toBe('comfortable');
    expect(() => writeContactsDensity('u1', 'compact')).not.toThrow();
  });
});

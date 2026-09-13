import { describe, expect, it } from 'vitest';

import type { QuickReply } from '@/types';

import {
  findSlashToken,
  isValidShortcut,
  matchQuickReplies,
  normalizeForMatch,
  replaceSlashToken,
} from './match';

const reply = (shortcut: string, title: string): QuickReply => ({
  id: shortcut,
  account_id: 'acc',
  shortcut,
  title,
  body: `body of ${shortcut}`,
  created_by: null,
  created_at: '2026-09-13T00:00:00Z',
  updated_at: '2026-09-13T00:00:00Z',
});

const replies = [
  reply('boasvindas', 'Boas-vindas'),
  reply('bv', 'Saudação curta'),
  reply('pix', 'Dados do Pix'),
  reply('horario', 'Horário de atendimento'),
  reply('endereco', 'Endereço da loja'),
  reply('obrigado', 'Agradecimento final'),
];

describe('isValidShortcut', () => {
  it('accepts lower-case letters, digits, _ and - up to 30 chars', () => {
    expect(isValidShortcut('boas-vindas_2')).toBe(true);
    expect(isValidShortcut('a')).toBe(true);
    expect(isValidShortcut('a'.repeat(30))).toBe(true);
  });

  it('rejects empty, spaces, upper-case, accents and > 30 chars', () => {
    expect(isValidShortcut('')).toBe(false);
    expect(isValidShortcut('boas vindas')).toBe(false);
    expect(isValidShortcut('Pix')).toBe(false);
    expect(isValidShortcut('horário')).toBe(false);
    expect(isValidShortcut('a'.repeat(31))).toBe(false);
  });
});

describe('findSlashToken', () => {
  it('detects "/" at the start of the text', () => {
    expect(findSlashToken('/', 1)).toEqual({ start: 0, end: 1, term: '' });
    expect(findSlashToken('/bo', 3)).toEqual({ start: 0, end: 3, term: 'bo' });
  });

  it('detects "/" after whitespace (space or newline)', () => {
    expect(findSlashToken('Oi /pi', 6)).toEqual({ start: 3, end: 6, term: 'pi' });
    expect(findSlashToken('Oi\n/h', 5)).toEqual({ start: 3, end: 5, term: 'h' });
  });

  it('ignores "/" glued to other text (dates, paths)', () => {
    expect(findSlashToken('12/09', 5)).toBeNull();
    expect(findSlashToken('a/b', 3)).toBeNull();
  });

  it('closes once a space follows the term', () => {
    expect(findSlashToken('/pix ', 5)).toBeNull();
    expect(findSlashToken('/pix ok', 7)).toBeNull();
  });

  it('only looks at text before the caret', () => {
    expect(findSlashToken('/pix depois', 4)).toEqual({ start: 0, end: 4, term: 'pix' });
  });

  it('returns null without any slash', () => {
    expect(findSlashToken('olá', 3)).toBeNull();
  });
});

describe('matchQuickReplies', () => {
  it('returns everything sorted by shortcut for an empty term', () => {
    expect(matchQuickReplies(replies, '').map((r) => r.shortcut)).toEqual([
      'boasvindas',
      'bv',
      'endereco',
      'horario',
      'obrigado',
      'pix',
    ]);
  });

  it('ranks shortcut prefix above title match', () => {
    // "b" → shortcuts boasvindas, bv; title "Agradecimento" also contains no "b"…
    // use "o": shortcuts obrigado; titles Boas-vindas, Saudação, Dados do Pix, Horário, Endereço
    expect(matchQuickReplies(replies, 'o').map((r) => r.shortcut)).toEqual([
      'obrigado',
      'boasvindas',
      'bv',
      'endereco',
      'horario',
      'pix',
    ]);
  });

  it('puts the exact shortcut first', () => {
    expect(matchQuickReplies([...replies, reply('b', 'Letra B')], 'b').map((r) => r.shortcut)).toEqual(
      ['b', 'boasvindas', 'bv'],
    );
  });

  it('matches titles case- and accent-insensitively', () => {
    expect(matchQuickReplies(replies, 'HORARIO').map((r) => r.shortcut)).toEqual(['horario']);
    expect(matchQuickReplies(replies, 'endereço').map((r) => r.shortcut)).toEqual(['endereco']);
    expect(matchQuickReplies(replies, 'saudação').map((r) => r.shortcut)).toEqual(['bv']);
  });

  it('drops non-matches and caps the list', () => {
    expect(matchQuickReplies(replies, 'zzz')).toEqual([]);
    expect(matchQuickReplies(replies, '', 2)).toHaveLength(2);
    const many = Array.from({ length: 12 }, (_, i) => reply(`r${i}`, `Reply ${i}`));
    expect(matchQuickReplies(many, '')).toHaveLength(8);
  });
});

describe('replaceSlashToken', () => {
  it('replaces the token at the end of the text', () => {
    const token = findSlashToken('Oi /pi', 6)!;
    expect(replaceSlashToken('Oi /pi', token, 'Chave Pix: 123')).toEqual({
      text: 'Oi Chave Pix: 123',
      caret: 17,
    });
  });

  it('keeps the existing space when the caret is mid-text', () => {
    const token = findSlashToken('/pix depois', 4)!;
    expect(replaceSlashToken('/pix depois', token, 'BODY')).toEqual({
      text: 'BODY depois',
      caret: 4,
    });
  });

  it('adds a space when text follows the token directly', () => {
    const token = findSlashToken('/pix', 4)!;
    expect(replaceSlashToken('/pixdepois', token, 'BODY')).toEqual({
      text: 'BODY depois',
      caret: 5,
    });
  });

  it('does not add a space when whitespace already follows', () => {
    const text = '/bv\nlinha 2';
    const token = findSlashToken(text, 3)!;
    expect(replaceSlashToken(text, token, 'Olá!')).toEqual({ text: 'Olá!\nlinha 2', caret: 4 });
  });
});

describe('normalizeForMatch', () => {
  it('lower-cases and strips diacritics', () => {
    expect(normalizeForMatch('  Endereço Ótimo ')).toBe('endereco otimo');
  });
});

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_REMINDER_TEXT,
  formatWhen,
  parseReminderReply,
  planSend,
  PREVIEW_VARS,
  REMINDER_OPTIONS_TEXT,
  reminderBody,
  renderReminderText,
  retryDelayMs,
  templateParams,
} from './reminders-core';

const NOW = new Date('2026-10-30T12:00:00Z');

describe('texts', () => {
  it('fills the variables, tolerant of case, accents and spaces; unknown braces stay', () => {
    const out = renderReminderText('Oi {Cliente}, {serviço} com { profissional } {data} {hora} {foo}', PREVIEW_VARS);
    expect(out).toBe('Oi Maria, Corte de cabelo com Ana sexta-feira, 30/10 14:30 {foo}');
  });

  it('falls back to the default text and always appends the reply options to free text', () => {
    expect(renderReminderText(null, PREVIEW_VARS)).toContain('Maria');
    expect(renderReminderText('   ', PREVIEW_VARS)).toContain('Corte de cabelo');
    expect(DEFAULT_REMINDER_TEXT).toContain('{hora}');
    const body = reminderBody('Lembrete {hora}', PREVIEW_VARS);
    expect(body).toBe(`Lembrete 14:30\n\n${REMINDER_OPTIONS_TEXT}`);
    expect(REMINDER_OPTIONS_TEXT).toBe('Responda 1 para confirmar ou 2 para remarcar.');
  });

  it('template parameters follow {{1}}..{{5}}', () => {
    expect(templateParams(PREVIEW_VARS)).toEqual(['Maria', 'Corte de cabelo', 'Ana', 'sexta-feira, 30/10', '14:30']);
  });

  it('formats date and time in the ACCOUNT timezone, not the server one', () => {
    const at = '2026-10-30T02:30:00Z';
    expect(formatWhen(at, 'America/Sao_Paulo')).toEqual({ data: 'quinta-feira, 29/10', hora: '23:30' });
    expect(formatWhen(at, 'America/Manaus')).toEqual({ data: 'quinta-feira, 29/10', hora: '22:30' });
    expect(formatWhen(at, 'Europe/Lisbon').hora).toBe('02:30');
    expect(formatWhen(at, 'not/a-zone').hora).toBe('23:30'); // falls back to the default zone
  });
});

describe('channel decision', () => {
  const base = { now: NOW, hasTemplate: false };
  it('QR sends free text with no window rule', () => {
    expect(planSend({ ...base, channel: 'qr', lastCustomerMessageAt: null })).toEqual({ kind: 'text' });
    expect(planSend({ ...base, channel: 'qr', lastCustomerMessageAt: '2020-01-01T00:00:00Z' })).toEqual({ kind: 'text' });
  });

  it('official: free text inside the 24 h window', () => {
    expect(planSend({ ...base, channel: 'official', lastCustomerMessageAt: '2026-10-29T13:00:00Z' })).toEqual({ kind: 'text' });
    expect(planSend({ ...base, hasTemplate: true, channel: 'official', lastCustomerMessageAt: '2026-10-30T11:00:00Z' })).toEqual({ kind: 'text' });
  });

  it('official: outside the window uses the template, or is skipped with a visible reason', () => {
    const old = '2026-10-29T11:59:00Z'; // 24 h + 1 min
    expect(planSend({ ...base, hasTemplate: true, channel: 'official', lastCustomerMessageAt: old })).toEqual({ kind: 'template' });
    expect(planSend({ ...base, channel: 'official', lastCustomerMessageAt: old })).toEqual({ kind: 'skip', reason: 'window_closed' });
    expect(planSend({ ...base, channel: 'official', lastCustomerMessageAt: null })).toEqual({ kind: 'skip', reason: 'window_closed' });
    expect(planSend({ ...base, hasTemplate: true, channel: 'official', lastCustomerMessageAt: 'garbage' })).toEqual({ kind: 'template' });
  });

  it('the throttled retry delay grows and is capped', () => {
    expect(retryDelayMs(1)).toBe(120_000);
    expect(retryDelayMs(3)).toBe(360_000);
    expect(retryDelayMs(50)).toBe(720_000);
  });
});

describe('reply parsing', () => {
  it.each(['1', ' 1 ', '1.', 'Sim', 'sim!', 'SIM', 'Confirmo', 'confirmado', 'Confirmar', 'ok', 'Ok!', 'pode confirmar', 'Sim, confirmo', 'estarei lá', '👍', '👍🏽', 'Tá confirmado'])(
    'confirms: %j',
    (text) => expect(parseReminderReply(text)).toBe('confirmed'),
  );

  it.each(['2', '2.', 'Remarcar', 'quero remarcar', 'preciso reagendar', 'Remarco', 'pode ser outro horário?', 'mudar horário', 'outro dia'])(
    'asks to reschedule: %j',
    (text) => expect(parseReminderReply(text)).toBe('reschedule_requested'),
  );

  it.each([
    '',
    '   ',
    'obrigado',
    'quanto custa?',
    'cancelar',
    'não posso ir',
    'não confirmo',
    'não quero remarcar',
    '1 e 2',
    '12',
    'sim mas preciso remarcar',
    'confirmo e remarco',
    '3',
    'qual o endereço de vocês? estarei lá às 14h confirmando tudo certo',
  ])('leaves ambiguous text to the human: %j', (text) => expect(parseReminderReply(text)).toBeNull());

  it('handles missing input', () => {
    expect(parseReminderReply(null)).toBeNull();
    expect(parseReminderReply(undefined)).toBeNull();
  });
});

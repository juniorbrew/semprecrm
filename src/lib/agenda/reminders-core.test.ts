import { describe, expect, it } from 'vitest';

import {
  canRetry,
  DEFAULT_REMINDER_TEXT,
  isTooLate,
  lateLimitMs,
  maskDigits,
  parseReminderReplyDetailed,
  reconnectDelayMs,
  safeFirstName,
  templateTakesFiveParams,
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

describe('reply parsing: emoji, repeated words, vague vs clear', () => {
  it.each(['Confirmo 👍', 'Sim 👍', 'Ok 👍', 'sim sim', 'Sim, confirmo!', 'confirmado ✅', 'Sim obrigado', '1 obrigada', '👍👍'])(
    'confirms: %j',
    (text) => expect(parseReminderReply(text)).toBe('confirmed'),
  );

  it('flags the vague ones (they need the reminder quoted or no later message from us)', () => {
    const vague = (t: string) => parseReminderReplyDetailed(t)?.vague;
    for (const t of ['ok', 'Ok!', 'ok 👍', 'certo', 'Beleza', 'blz', 'pode ser', 'combinado', 'tudo certo', 's', '👍', '✅']) expect(vague(t), t).toBe(true);
    for (const t of ['1', 'sim', 'Confirmo', 'Confirmo 👍', 'ok sim', 'pode confirmar', 'estarei lá', '2', 'remarcar']) expect(vague(t), t).toBe(false);
  });

  it('obrigado alone is neutral, not an answer; mixed word + move is still ambiguous', () => {
    expect(parseReminderReply('obrigado')).toBeNull();
    expect(parseReminderReply('ok remarcar')).toBeNull();
    expect(parseReminderReply('👍 2')).toBeNull();
  });
});

describe('sanitizing and masking', () => {
  it('first name keeps letters, marks, apostrophe and hyphen only, max 30', () => {
    expect(safeFirstName('Maria Silva')).toBe('Maria');
    expect(safeFirstName('  João-Pedro  Souza')).toBe('João-Pedro');
    expect(safeFirstName("D'Ávila")).toBe("D'Ávila");
    expect(safeFirstName('Ana{{1}} http://x.co')).toBe('Ana');
    expect(safeFirstName('Ana<script>')).toBe('Anascript');
    expect(safeFirstName('A'.repeat(80))).toHaveLength(30);
    for (const bad of ['', '   ', '1234', '😀😀', null, undefined]) expect(safeFirstName(bad)).toBe('tudo bem');
  });

  it('template params: single spaces, no newlines, never empty', () => {
    const p = templateParams({ cliente: 'Ana', servico: 'Corte\n  e   barba', profissional: ' \t ', data: 'sábado,\r\n31/10', hora: '14:30' });
    expect(p).toEqual(['Ana', 'Corte e barba', '-', 'sábado, 31/10', '14:30']);
  });

  it('masks phone numbers in error text, keeps short numbers and times', () => {
    expect(maskDigits('send to 5511999990000 failed')).toBe('send to *** failed');
    expect(maskDigits('número +55 (11) 99999-0000 inválido')).toBe('número *** inválido');
    expect(maskDigits('HTTP 429 at 14:30, retry in 120 s')).toBe('HTTP 429 at 14:30, retry in 120 s');
  });

  it('the approved template must take exactly {{1}}..{{5}}', () => {
    expect(templateTakesFiveParams('Olá {{1}}, {{2}} com {{3}} em {{4}} às {{5}}. Responda 1 ou 2.')).toBe(true);
    expect(templateTakesFiveParams('{{1}} {{2}} {{3}} {{4}} {{5}} {{5}}')).toBe(true);
    expect(templateTakesFiveParams('Olá {{1}}, {{2}}')).toBe(false);
    expect(templateTakesFiveParams('{{1}} {{2}} {{3}} {{4}} {{5}} {{6}}')).toBe(false);
    expect(templateTakesFiveParams(null)).toBe(false);
  });
});

describe('late cron and reconnect retry', () => {
  const due = '2026-10-30T10:00:00Z';
  it('stale after max(30 min, half the lead time)', () => {
    expect(lateLimitMs(120)).toBe(60 * 60_000);
    expect(lateLimitMs(1440)).toBe(720 * 60_000);
    expect(lateLimitMs(30)).toBe(30 * 60_000);
    expect(isTooLate(new Date('2026-10-30T10:59:00Z'), due, 120)).toBe(false);
    expect(isTooLate(new Date('2026-10-30T11:01:00Z'), due, 120)).toBe(true);
    expect(isTooLate(new Date('2026-10-30T20:00:00Z'), due, 1440)).toBe(false);
  });

  it('backoff 5..30 min; retry only while the appointment and freshness allow it', () => {
    expect(reconnectDelayMs(1)).toBe(300_000);
    expect(reconnectDelayMs(9)).toBe(1_800_000);
    const base = { dueAt: due, offsetMinutes: 120, startsAt: '2026-10-30T12:00:00Z', delayMs: 300_000 };
    expect(canRetry({ ...base, now: new Date('2026-10-30T10:05:00Z') })).toBe(true);
    expect(canRetry({ ...base, now: new Date('2026-10-30T10:58:00Z') })).toBe(false); // next try is stale
    expect(canRetry({ ...base, offsetMinutes: 1440, startsAt: '2026-10-30T10:10:00Z', now: new Date('2026-10-30T10:07:00Z') })).toBe(false); // after the appointment
  });
});

// ============================================================
// WhatsApp appointment reminders (migration 097) — pure rules: texts, channel
// decision, reply parsing, retry pacing. No I/O and no hidden clock.
// The cron (reminders.ts) and the inbound hook (reminder-reply.ts) use these.
// ============================================================

import { safeTimezone } from '@/lib/calendar/range';

/** Defaults of a new account (owner decision 2026-10-25): 1 day and 2 hours before. */
export const DEFAULT_FIRST_OFFSET_MINUTES = 1440;
export const DEFAULT_SECOND_OFFSET_MINUTES = 120;
export const REMINDER_MIN_OFFSET_MINUTES = 5;
export const REMINDER_MAX_OFFSET_MINUTES = 20_160;
export const REMINDER_TEXT_MAX = 1000;

export const DEFAULT_REMINDER_TEXT =
  'Olá, {cliente}! Passando para lembrar do seu horário: {servico} com {profissional}, {data} às {hora}.';
/** Always appended to free text, so the reply stays something the system can read. */
export const REMINDER_OPTIONS_TEXT = 'Responda 1 para confirmar ou 2 para remarcar.';

export interface ReminderSettings {
  enabled: boolean;
  first_offset_minutes: number | null;
  second_offset_minutes: number | null;
  message_text: string | null;
  template_name: string | null;
  template_language: string;
}

export const DEFAULT_REMINDER_SETTINGS: ReminderSettings = {
  enabled: false,
  first_offset_minutes: DEFAULT_FIRST_OFFSET_MINUTES,
  second_offset_minutes: DEFAULT_SECOND_OFFSET_MINUTES,
  message_text: null,
  template_name: null,
  template_language: 'pt_BR',
};

/** Variables the message text accepts, in the order the approved template body takes them ({{1}}..{{5}}). */
export const REMINDER_VARIABLES = ['cliente', 'servico', 'profissional', 'data', 'hora'] as const;
export type ReminderVariable = (typeof REMINDER_VARIABLES)[number];
export type ReminderVars = Record<ReminderVariable, string>;

/** Why a reminder did not go out (stored in `agenda_reminders.reason`; the UI translates the code). */
export const SKIP_REASONS = [
  'past', // the offset had already passed when the appointment was made
  'disabled', // reminders were switched off before it was due
  'appointment_closed', // cancelled / no-show / completed / already started
  'no_phone',
  'opted_out',
  'anonymized',
  'no_conversation',
  'read_only',
  'window_closed', // official channel, outside the 24 h window, and no template configured
  'template_unavailable', // the configured template is gone / not approved
  'whatsapp_disconnected', // QR session down for as long as it was still worth retrying
  'channel_not_configured', // official channel not set up for the account
  'daily_limit', // the account hit its 24 h reminder cap
  'late', // the cron claimed it far too late to still be a useful reminder
  'reschedule_requested', // the customer asked to reschedule: a human takes over
] as const;
export type SkipReason = (typeof SKIP_REASONS)[number];

export function isSkipReason(value: unknown): value is SkipReason {
  return typeof value === 'string' && (SKIP_REASONS as readonly string[]).includes(value);
}

const strip = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** `{cliente}`, `{Serviço}`, `{ hora }` — accents, case and inner spaces do not matter. Unknown braces stay. */
export function renderReminderText(template: string | null | undefined, vars: ReminderVars): string {
  const text = template && template.trim() ? template : DEFAULT_REMINDER_TEXT;
  return text.replace(/\{\s*([^{}\s]+)\s*\}/g, (whole, name: string) => {
    const key = strip(name) as ReminderVariable;
    return (REMINDER_VARIABLES as readonly string[]).includes(key) ? vars[key] : whole;
  });
}

/** Free-text body: the configured text plus the reply options. */
export function reminderBody(template: string | null | undefined, vars: ReminderVars): string {
  return `${renderReminderText(template, vars).trim()}\n\n${REMINDER_OPTIONS_TEXT}`;
}

/** Body parameters of the approved template, {{1}}..{{5}}. */
export function templateParams(vars: ReminderVars): string[] {
  // Meta rejects newlines / tabs / runs of spaces in a template parameter, and an empty one.
  return REMINDER_VARIABLES.map((k) => vars[k].replace(/\s+/g, ' ').trim() || '-');
}

/** Distinct {{n}} placeholders of a template body, ascending. */
export function templateBodyIndexes(body: string | null | undefined): number[] {
  const found = new Set<number>();
  for (const m of (body ?? '').matchAll(/\{\{\s*(\d+)\s*\}\}/g)) found.add(Number(m[1]));
  return [...found].sort((a, b) => a - b);
}

/** The approved template must take exactly {{1}}..{{5}} (customer, service, professional, date, time). */
export function templateTakesFiveParams(body: string | null | undefined): boolean {
  return templateBodyIndexes(body).join(',') === '1,2,3,4,5';
}

/** First name, safe to put in a message / template: letters, marks, apostrophe, hyphen; max 30. */
export function safeFirstName(name: string | null | undefined): string {
  const first = (name ?? '').trim().split(/\s+/)[0] ?? '';
  const clean = first.replace(/[^\p{L}\p{M}'-]/gu, '').slice(0, 30);
  return clean || 'tudo bem';
}

/** Gateway / provider error text without phone numbers (LGPD): 6+ digit runs, also with separators, become ***. */
export function maskDigits(text: string): string {
  return text.replace(/\+?\d[\d\s().-]{4,}\d/g, (m) => (m.replace(/\D/g, '').length >= 6 ? '***' : m)).replace(/\d{6,}/g, '***');
}

// ------------------------------------------------------------
// Limits
// ------------------------------------------------------------

/** Reminders an account may send per rolling 24 h (abuse / runaway guard). 200 covers a busy clinic (two per visit). */
export const DAILY_REMINDER_LIMIT = 200;

/** Claimed this long after it was due (or more) the reminder is stale: max(30 min, half its lead time). */
export function lateLimitMs(offsetMinutes: number): number {
  return Math.max(30 * 60_000, offsetMinutes * 30_000);
}

export function isTooLate(now: Date, dueAt: string | Date, offsetMinutes: number): boolean {
  return now.getTime() - new Date(dueAt).getTime() > lateLimitMs(offsetMinutes);
}

/** Backoff while the WhatsApp session / channel is down: 5, 10 ... 30 min. */
export function reconnectDelayMs(attempts: number): number {
  return Math.min(Math.max(1, attempts), 6) * 5 * 60_000;
}

/** Retry only while the next try is still before the appointment and not yet stale. */
export function canRetry(input: { now: Date; delayMs: number; dueAt: string | Date; offsetMinutes: number; startsAt: string | Date }): boolean {
  const next = new Date(input.now.getTime() + input.delayMs);
  return next.getTime() < new Date(input.startsAt).getTime() && !isTooLate(next, input.dueAt, input.offsetMinutes);
}

/** "sexta-feira, 30/10" and "14:30" in the ACCOUNT zone (never the server's). */
export function formatWhen(startsAt: string | Date, timezone: string): { data: string; hora: string } {
  const tz = safeTimezone(timezone);
  const d = typeof startsAt === 'string' ? new Date(startsAt) : startsAt;
  const data = new Intl.DateTimeFormat('pt-BR', { timeZone: tz, weekday: 'long', day: '2-digit', month: '2-digit' }).format(d);
  const hora = new Intl.DateTimeFormat('pt-BR', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);
  return { data, hora };
}

/** A preview with sample values, for the settings screen. */
export const PREVIEW_VARS: ReminderVars = {
  cliente: 'Maria',
  servico: 'Corte de cabelo',
  profissional: 'Ana',
  data: 'sexta-feira, 30/10',
  hora: '14:30',
};

// ------------------------------------------------------------
// Channel decision
// ------------------------------------------------------------

export type SendPlan = { kind: 'text' } | { kind: 'template' } | { kind: 'skip'; reason: SkipReason };

/**
 * QR: always free text (no window). Official: free text only inside the 24 h
 * service window; outside it only an approved template may be sent — and only if
 * the account configured one, otherwise the reminder is skipped with a visible reason.
 */
export function planSend(input: {
  channel: 'qr' | 'official';
  lastCustomerMessageAt: string | null | undefined;
  now: Date;
  hasTemplate: boolean;
}): SendPlan {
  if (input.channel === 'qr') return { kind: 'text' };
  const t = input.lastCustomerMessageAt ? Date.parse(input.lastCustomerMessageAt) : NaN;
  const inside = Number.isFinite(t) && input.now.getTime() - t < 24 * 3_600_000;
  if (inside) return { kind: 'text' };
  return input.hasTemplate ? { kind: 'template' } : { kind: 'skip', reason: 'window_closed' };
}

/** Throttled sends are retried a few minutes later, never lost; after this many tries it fails visibly. */
export const MAX_SEND_ATTEMPTS = 8;

export function retryDelayMs(attempts: number): number {
  return Math.min(Math.max(1, attempts), 6) * 2 * 60_000;
}

// ------------------------------------------------------------
// Customer reply
// ------------------------------------------------------------

export type ReminderAction = 'confirmed' | 'reschedule_requested';

/** A sent reminder waits this long for an answer; older ones are left to the human. */
export const REPLY_WINDOW_MS = 48 * 3_600_000;

/** Clear words: they answer the reminder on their own, within the 48 h window. */
const STRONG_CONFIRM = new Set(['1', 'sim', 'confirmo', 'confirmado', 'confirmada', 'confirmar', 'confirma']);
/** Vague words: only an answer when they quote the reminder or nobody wrote after it. */
const VAGUE_CONFIRM = new Set(['s', 'ok', 'okay', 'blz', 'beleza', 'certo', 'combinado', 'thumbsup']);
const NEUTRAL = new Set(['obrigado', 'obrigada', 'brigado', 'valeu', 'grato', 'grata']);
const STRONG_PHRASES = new Set(['pode confirmar', 'estarei la', 'estarei ai', 'vou sim', 'ta confirmado', 'esta confirmado']);
const VAGUE_PHRASES = new Set(['pode ser', 'tudo certo']);
const RESCHEDULE_WORDS = ['remarcar', 'remarco', 'remarca', 'remarque', 'reagendar', 'reagendo', 'reagenda', 'adiar', 'trocar horario', 'mudar horario', 'mudar o horario', 'outro horario', 'outro dia', 'trocar o horario', 'trocar de horario', 'mudar de horario'];

export interface ParsedReply {
  action: ReminderAction;
  /** Only vague words (ok, certo, 👍...): needs the reminder quoted or no later message from us. */
  vague: boolean;
}

/**
 * "1" / "sim" / "confirmo" (+ 👍 ✅, repeated words, thanks) -> confirmed; "2" / "remarcar" -> reschedule_requested.
 * Anything else is null: ambiguity ("não posso", "cancelar", "1 e 2", "sim, mas...") is left to the human.
 */
export function parseReminderReplyDetailed(raw: string | null | undefined): ParsedReply | null {
  if (!raw) return null;
  const text = strip(raw)
    .replace(/(\u{1F44D}|\u2705|\u2714)[\u{1F3FB}-\u{1F3FF}\ufe0f]?/gu, ' thumbsup ')
    .replace(/[\p{Extended_Pictographic}\u200d\ufe0f]/gu, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text || text.length > 60 || text.split(' ').length > 8) return null;

  const tokens = [...new Set(text.split(' '))].filter((t) => !NEUTRAL.has(t));
  if (tokens.length === 0) return null;
  const joined = tokens.join(' ');
  const padded = ` ${text} `;

  const wantsMove = tokens.includes('2') || RESCHEDULE_WORDS.some((w) => padded.includes(` ${w} `));
  const hasConfirm = tokens.some((t) => STRONG_CONFIRM.has(t) || VAGUE_CONFIRM.has(t));
  if (wantsMove) {
    if (hasConfirm || tokens.includes('nao') || tokens.some((t) => t.startsWith('cancel'))) return null;
    return { action: 'reschedule_requested', vague: false };
  }
  if (STRONG_PHRASES.has(joined)) return { action: 'confirmed', vague: false };
  if (VAGUE_PHRASES.has(joined)) return { action: 'confirmed', vague: true };
  if (tokens.every((t) => STRONG_CONFIRM.has(t) || VAGUE_CONFIRM.has(t))) {
    return { action: 'confirmed', vague: !tokens.some((t) => STRONG_CONFIRM.has(t)) };
  }
  return null;
}

/** The action only (see parseReminderReplyDetailed for the vague flag). */
export function parseReminderReply(raw: string | null | undefined): ReminderAction | null {
  return parseReminderReplyDetailed(raw)?.action ?? null;
}

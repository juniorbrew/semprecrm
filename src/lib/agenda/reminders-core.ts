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
  return REMINDER_VARIABLES.map((k) => vars[k]);
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

const CONFIRM = new Set([
  '1', 'sim', 's', 'confirmo', 'confirmado', 'confirmada', 'confirmar', 'confirma', 'ok', 'okay', 'blz', 'beleza', 'certo', 'combinado',
  'pode confirmar', 'pode ser', 'estarei la', 'estarei ai', 'vou sim', 'sim confirmo', 'sim confirmado', 'ta confirmado', 'esta confirmado', 'tudo certo',
]);
/** Any of these inside a reschedule request makes the message mixed ("sim, mas remarcar"): human. */
const CONFIRM_TOKENS = new Set(['1', 'sim', 'confirmo', 'confirmado', 'confirmada', 'confirmar', 'confirma', 'ok']);
const RESCHEDULE_WORDS = ['remarcar', 'remarco', 'remarca', 'remarque', 'reagendar', 'reagendo', 'reagenda', 'adiar', 'trocar horario', 'mudar horario', 'mudar o horario', 'outro horario', 'outro dia', 'trocar o horario', 'trocar de horario', 'mudar de horario'];

/**
 * "1" / "sim" / "confirmo" -> confirmed; "2" / "remarcar" -> reschedule_requested.
 * Anything else is null: ambiguity ("não posso", "cancelar", "1 e 2", "sim, mas...") is
 * left to the human — the system never guesses.
 */
export function parseReminderReply(raw: string | null | undefined): ReminderAction | null {
  if (!raw) return null;
  const text = strip(raw)
    .replace(/[\p{Extended_Pictographic}‍️]/gu, (m) => (m === '\u{1F44D}' ? ' sim ' : ' '))
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text || text.length > 60 || text.split(' ').length > 8) return null;
  // The original may be just the thumbs-up emoji: handled above as "sim".
  const wantsMove = text === '2' || RESCHEDULE_WORDS.some((w) => ` ${text} `.includes(` ${w} `));
  const wantsConfirm = CONFIRM.has(text);
  const mixed = text.split(' ').some((w) => CONFIRM_TOKENS.has(w));
  if (wantsMove && !wantsConfirm && !mixed) return /\bnao\b|\bcancel/.test(text) ? null : 'reschedule_requested';
  if (wantsConfirm && !wantsMove) return 'confirmed';
  return null;
}

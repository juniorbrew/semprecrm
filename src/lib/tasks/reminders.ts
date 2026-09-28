// ============================================================
// Conversation reminders ("Lembrar" in the inbox header).
//
// A reminder is a task (migration 027) linked to the conversation and
// its contact, assigned to the agent who set it, due and reminded at
// the chosen time (`remind_at`, migration 057). The cron pushes it at
// that time (lib/push/notify → notifyTaskReminders) and the push opens
// the conversation. It also shows up in the contact panel's task list
// and on /tasks like any other task.
//
// Pure helpers, injectable `now`.
// ============================================================

import type { Language } from '@/lib/i18n';

import type { TaskInput } from './types';

export type ReminderPreset = 'in1h' | 'in3h' | 'tomorrow9';

export const REMINDER_PRESETS: readonly ReminderPreset[] = ['in1h', 'in3h', 'tomorrow9'];

/** Furthest a reminder may be set (sanity bound for the custom picker). */
export const REMINDER_MAX_AHEAD_MS = 366 * 24 * 60 * 60 * 1000;

const HOUR_MS = 60 * 60 * 1000;

/** The instant a preset stands for. "Amanhã às 9h" is 09:00 local time. */
export function reminderPresetTime(preset: ReminderPreset, now: number = Date.now()): Date {
  switch (preset) {
    case 'in1h':
      return new Date(now + HOUR_MS);
    case 'in3h':
      return new Date(now + 3 * HOUR_MS);
    case 'tomorrow9': {
      const d = new Date(now);
      d.setDate(d.getDate() + 1);
      d.setHours(9, 0, 0, 0);
      return d;
    }
  }
}

export type ReminderTimeError = 'invalid' | 'past' | 'too_far';

/** A reminder must be a real instant, in the future, within a year. */
export function validateReminderTime(when: Date | null, now: number = Date.now()): ReminderTimeError | null {
  if (!when || Number.isNaN(when.getTime())) return 'invalid';
  if (when.getTime() <= now) return 'past';
  if (when.getTime() - now > REMINDER_MAX_AHEAD_MS) return 'too_far';
  return null;
}

const TITLE_PREFIX: Record<Language, string> = { 'pt-BR': 'Lembrete', 'en-US': 'Reminder' };
const MAX_TITLE = 200;

/**
 * The task behind a reminder. Title: "Lembrete: <contact>" (the note,
 * if any, becomes the description), assigned to the agent, due and
 * reminded at `when`.
 */
export function buildReminderTask(params: {
  when: Date;
  contactName: string;
  contactId: string;
  conversationId: string;
  userId: string;
  note?: string | null;
  language: Language;
}): TaskInput {
  const who = params.contactName.trim() || '—';
  const title = `${TITLE_PREFIX[params.language] ?? TITLE_PREFIX['pt-BR']}: ${who}`.slice(0, MAX_TITLE);
  const at = params.when.toISOString();
  const note = params.note?.trim();
  return {
    title,
    description: note ? note : null,
    priority: 'normal',
    assignee_user_id: params.userId,
    contact_id: params.contactId,
    conversation_id: params.conversationId,
    due_at: at,
    remind_at: at,
  };
}

/** "hoje 14:30" / "amanhã 09:00" / "12/10 09:00" for the header chip. */
export function formatReminderWhen(when: Date, language: Language, now: number = Date.now()): string {
  const time = when.toLocaleTimeString(language, { hour: '2-digit', minute: '2-digit' });
  const day = (d: Date) => {
    const x = new Date(d);
    x.setHours(0, 0, 0, 0);
    return x.getTime();
  };
  const days = Math.round((day(when) - day(new Date(now))) / (24 * HOUR_MS));
  const pt = language === 'pt-BR';
  if (days === 0) return pt ? `hoje ${time}` : `today ${time}`;
  if (days === 1) return pt ? `amanhã ${time}` : `tomorrow ${time}`;
  const date = when.toLocaleDateString(language, { day: '2-digit', month: '2-digit' });
  return `${date} ${time}`;
}

/**
 * The reminder can be saved: not already saving, and the account's task
 * statuses are loaded (`createTask` needs the default status).
 */
export function canSaveReminder(state: { saving: boolean; statusesLoaded: number }): boolean {
  return !state.saving && state.statusesLoaded > 0;
}

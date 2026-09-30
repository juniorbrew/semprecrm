import { describe, expect, it } from 'vitest';

import {
  REMINDER_MAX_AHEAD_MS,
  buildDrawerTaskInput,
  isDueInPast,
  resolveTaskReminder,
  buildReminderTask,
  canSaveReminder,
  formatReminderWhen,
  reminderPresetTime,
  validateReminderTime,
} from './reminders';

// 2026-09-12 (Saturday) 22:30 local.
const now = new Date(2026, 8, 12, 22, 30, 0).getTime();

describe('reminderPresetTime', () => {
  it('adds one or three hours', () => {
    expect(reminderPresetTime('in1h', now).getTime()).toBe(now + 3_600_000);
    expect(reminderPresetTime('in3h', now).getTime()).toBe(now + 3 * 3_600_000);
  });

  it('"tomorrow 9h" is 09:00 local on the next calendar day, even late at night', () => {
    const t = reminderPresetTime('tomorrow9', now);
    expect(t.getFullYear()).toBe(2026);
    expect(t.getMonth()).toBe(8);
    expect(t.getDate()).toBe(13);
    expect(t.getHours()).toBe(9);
    expect(t.getMinutes()).toBe(0);
    // Month rollover.
    const endOfMonth = new Date(2026, 8, 30, 10, 0).getTime();
    const next = reminderPresetTime('tomorrow9', endOfMonth);
    expect([next.getMonth(), next.getDate(), next.getHours()]).toEqual([9, 1, 9]);
  });
});

describe('validateReminderTime', () => {
  it('accepts a future instant within a year', () => {
    expect(validateReminderTime(new Date(now + 60_000), now)).toBeNull();
    expect(validateReminderTime(new Date(now + REMINDER_MAX_AHEAD_MS), now)).toBeNull();
  });

  it('rejects past, now, invalid and too far', () => {
    expect(validateReminderTime(new Date(now), now)).toBe('past');
    expect(validateReminderTime(new Date(now - 1), now)).toBe('past');
    expect(validateReminderTime(new Date('nope'), now)).toBe('invalid');
    expect(validateReminderTime(null, now)).toBe('invalid');
    expect(validateReminderTime(new Date(now + REMINDER_MAX_AHEAD_MS + 1), now)).toBe('too_far');
  });
});

describe('buildReminderTask', () => {
  const when = new Date(now + 3_600_000);

  it('links the conversation + contact, assigns the agent, due and reminded at the same time', () => {
    const task = buildReminderTask({
      when,
      contactName: 'Maria Souza',
      contactId: 'contact-1',
      conversationId: 'conv-1',
      userId: 'user-1',
      note: '  Retornar sobre o orçamento  ',
      language: 'pt-BR',
    });
    expect(task).toEqual({
      title: 'Lembrete: Maria Souza',
      description: 'Retornar sobre o orçamento',
      priority: 'normal',
      assignee_user_id: 'user-1',
      contact_id: 'contact-1',
      conversation_id: 'conv-1',
      due_at: when.toISOString(),
      remind_at: when.toISOString(),
    });
  });

  it('English title, empty note → null description, long names capped', () => {
    const task = buildReminderTask({
      when,
      contactName: 'x'.repeat(300),
      contactId: 'c',
      conversationId: 'v',
      userId: 'u',
      note: '   ',
      language: 'en-US',
    });
    expect(task.title.startsWith('Reminder: ')).toBe(true);
    expect(task.title.length).toBe(200);
    expect(task.description).toBeNull();
  });
});

describe('formatReminderWhen', () => {
  it('says today / tomorrow / a date', () => {
    expect(formatReminderWhen(new Date(2026, 8, 12, 23, 0), 'pt-BR', now)).toMatch(/^hoje 23:00$/);
    expect(formatReminderWhen(new Date(2026, 8, 13, 9, 0), 'pt-BR', now)).toMatch(/^amanhã 09:00$/);
    expect(formatReminderWhen(new Date(2026, 8, 13, 9, 0), 'en-US', now)).toMatch(/^tomorrow/);
    expect(formatReminderWhen(new Date(2026, 9, 2, 9, 0), 'pt-BR', now)).toMatch(/^02\/10 09:00$/);
  });
});

describe('canSaveReminder', () => {
  it('waits for the task statuses and for a save in flight', () => {
    expect(canSaveReminder({ saving: false, statusesLoaded: 0 })).toBe(false);
    expect(canSaveReminder({ saving: true, statusesLoaded: 3 })).toBe(false);
    expect(canSaveReminder({ saving: false, statusesLoaded: 3 })).toBe(true);
  });
});

describe('task drawer helpers', () => {
  const due = new Date(2026, 8, 20, 15, 0, 0).toISOString();

  it('resolves the reminder modes', () => {
    expect(resolveTaskReminder('none', due, '')).toBeNull();
    expect(resolveTaskReminder('at_due', due, '')).toBe(due);
    expect(resolveTaskReminder('hour_before', due, '')).toBe(new Date(2026, 8, 20, 14, 0, 0).toISOString());
    expect(resolveTaskReminder('at_due', null, '')).toBeNull();
    expect(resolveTaskReminder('custom', null, '2026-09-21T09:30')).toBe(new Date(2026, 8, 21, 9, 30).toISOString());
    expect(resolveTaskReminder('custom', null, '')).toBeNull();
  });

  it('flags a past due date', () => {
    expect(isDueInPast(due, now)).toBe(false);
    expect(isDueInPast(new Date(now - 1000).toISOString(), now)).toBe(true);
    expect(isDueInPast(null, now)).toBe(false);
  });

  it('builds the create payload with contact, conversation, assignee and remind_at', () => {
    expect(
      buildDrawerTaskInput({
        title: '  Ligar  ',
        description: '',
        priority: 'high',
        statusId: '',
        assignee: 'u-1',
        contactId: 'c-1',
        conversationId: 'conv-1',
        dealId: '',
        dueIso: due,
        remindIso: due,
      }),
    ).toEqual({
      title: 'Ligar',
      description: '',
      priority: 'high',
      status_id: null,
      assignee_user_id: 'u-1',
      contact_id: 'c-1',
      conversation_id: 'conv-1',
      deal_id: null,
      due_at: due,
      remind_at: due,
    });
  });
});

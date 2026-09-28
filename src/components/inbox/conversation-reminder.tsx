"use client";

import { useCallback, useEffect, useState } from "react";
import { AlarmClock, Loader2, X } from "lucide-react";
import { toast } from "sonner";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useTaskStatuses } from "@/components/tasks";
import { useAuth } from "@/hooks/use-auth";
import { useLanguage } from "@/hooks/use-language";
import type { Language } from "@/lib/i18n";
import { createClient } from "@/lib/supabase/client";
import {
  REMINDER_PRESETS,
  buildReminderTask,
  canSaveReminder,
  createTask,
  deleteTask,
  formatReminderWhen,
  fromDateTimeLocal,
  reminderPresetTime,
  toDateTimeLocal,
  validateReminderTime,
  type ReminderPreset,
  type ReminderTimeError,
} from "@/lib/tasks";
import { cn } from "@/lib/utils";

/**
 * Copy is language-keyed (interpolated forms) and the popover is
 * `data-no-translate`, like the rest of the thread header.
 */
const COPY: Record<
  Language,
  {
    remind: string;
    title: string;
    hint: string;
    presets: Record<ReminderPreset, string>;
    custom: string;
    note: string;
    save: string;
    active: (when: string) => string;
    cancel: string;
    created: (when: string) => string;
    cancelled: string;
    failed: string;
    readOnly: string;
    errors: Record<ReminderTimeError, string>;
  }
> = {
  "pt-BR": {
    remind: "Lembrar",
    title: "Lembrar desta conversa",
    hint: "Você recebe uma notificação no horário escolhido. O lembrete vira uma tarefa ligada a esta conversa.",
    presets: { in1h: "Em 1 hora", in3h: "Em 3 horas", tomorrow9: "Amanhã às 9h" },
    custom: "Ou escolha data e hora",
    note: "Nota (opcional)",
    save: "Criar lembrete",
    active: (when) => `Lembrete ${when}`,
    cancel: "Cancelar lembrete",
    created: (when) => `Lembrete criado para ${when}`,
    cancelled: "Lembrete cancelado",
    failed: "Não foi possível salvar o lembrete",
    readOnly: "Somente leitura — seu perfil não pode criar lembretes",
    errors: {
      invalid: "Escolha uma data e hora válidas",
      past: "Escolha um horário no futuro",
      too_far: "Escolha uma data dentro de um ano",
    },
  },
  "en-US": {
    remind: "Remind me",
    title: "Remind me about this conversation",
    hint: "You get a notification at the chosen time. The reminder becomes a task linked to this conversation.",
    presets: { in1h: "In 1 hour", in3h: "In 3 hours", tomorrow9: "Tomorrow at 9am" },
    custom: "Or pick a date and time",
    note: "Note (optional)",
    save: "Create reminder",
    active: (when) => `Reminder ${when}`,
    cancel: "Cancel reminder",
    created: (when) => `Reminder set for ${when}`,
    cancelled: "Reminder cancelled",
    failed: "Could not save the reminder",
    readOnly: "Read-only — your role can't create reminders",
    errors: {
      invalid: "Pick a valid date and time",
      past: "Pick a time in the future",
      too_far: "Pick a date within a year",
    },
  },
};

interface ActiveReminder {
  id: string;
  remind_at: string;
}

/**
 * "Lembrar" in the thread header: a reminder task (lib/tasks/reminders)
 * linked to this conversation + contact, assigned to me, pushed by the
 * cron at the chosen time. Shows my next pending reminder for the
 * conversation, which can be cancelled (the task is deleted).
 */
export function ConversationReminder({
  conversationId,
  contactId,
  contactName,
  disabled,
}: {
  conversationId: string;
  contactId: string;
  contactName: string;
  /** Viewer (or role still loading): rendered, not clickable. */
  disabled: boolean;
}) {
  const { user, accountId } = useAuth();
  const { language } = useLanguage();
  const copy = COPY[language] ?? COPY["pt-BR"];
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [custom, setCustom] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [active, setActive] = useState<ActiveReminder | null>(null);
  const { statuses } = useTaskStatuses({ enabled: open });
  // createTask needs the account's default status; until the statuses
  // arrive (the popover loads them on open) nothing can be saved.
  const statusesReady = statuses.length > 0;
  const busy = !canSaveReminder({ saving, statusesLoaded: statuses.length });
  const userId = user?.id ?? null;

  // My next pending reminder on this conversation. A pre-057 schema
  // (no remind_at) simply shows none.
  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    createClient()
      .from("tasks")
      .select("id, remind_at")
      .eq("conversation_id", conversationId)
      .eq("assignee_user_id", userId)
      .is("completed_at", null)
      .gt("remind_at", new Date().toISOString())
      .order("remind_at", { ascending: true })
      .limit(1)
      .then(({ data, error: err }) => {
        if (cancelled) return;
        setActive(err ? null : ((data?.[0] as ActiveReminder | undefined) ?? null));
      });
    return () => {
      cancelled = true;
    };
  }, [conversationId, userId]);

  const create = useCallback(
    async (when: Date) => {
      if (!statusesReady) return;
      const problem = validateReminderTime(when);
      if (problem) {
        setError(copy.errors[problem]);
        return;
      }
      if (!accountId || !userId) {
        toast.error(copy.failed);
        return;
      }
      setSaving(true);
      setError(null);
      try {
        const task = await createTask(
          createClient(),
          { accountId, userId, statuses },
          buildReminderTask({
            when,
            contactName,
            contactId,
            conversationId,
            userId,
            note,
            language,
          }),
        );
        setActive({ id: task.id, remind_at: task.remind_at ?? when.toISOString() });
        toast.success(copy.created(formatReminderWhen(when, language)));
        setOpen(false);
        setNote("");
        setCustom("");
      } catch (err) {
        console.error("[inbox] reminder:", err);
        toast.error(copy.failed);
      } finally {
        setSaving(false);
      }
    },
    [accountId, userId, statuses, statusesReady, contactName, contactId, conversationId, note, language, copy],
  );

  const cancelActive = useCallback(async () => {
    if (!active) return;
    setSaving(true);
    try {
      await deleteTask(createClient(), active.id);
      setActive(null);
      toast.success(copy.cancelled);
      setOpen(false);
    } catch (err) {
      console.error("[inbox] cancel reminder:", err);
      toast.error(copy.failed);
    } finally {
      setSaving(false);
    }
  }, [active, copy]);

  const activeLabel = active ? copy.active(formatReminderWhen(new Date(active.remind_at), language)) : null;
  const triggerLabel = disabled ? copy.readOnly : (activeLabel ?? copy.remind);

  return (
    <Popover open={open} onOpenChange={(next) => !disabled && setOpen(next)}>
      <PopoverTrigger
        disabled={disabled}
        aria-label={triggerLabel}
        title={triggerLabel}
        data-no-translate
        className={cn(
          "inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-xs transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50 data-popup-open:bg-muted",
          active ? "text-primary" : "text-muted-foreground",
        )}
      >
        <AlarmClock className="h-3.5 w-3.5" />
        <span className="hidden max-w-32 truncate @2xl:inline">{activeLabel ?? copy.remind}</span>
      </PopoverTrigger>
      <PopoverContent align="end" data-no-translate className="w-72 border-border bg-popover p-3">
        <p className="text-sm font-medium text-popover-foreground">{copy.title}</p>
        <p className="mt-0.5 text-[11px] leading-4 text-muted-foreground">{copy.hint}</p>

        {active && (
          <div className="mt-2 flex items-center justify-between gap-2 rounded-md bg-primary/10 px-2 py-1.5 text-xs text-primary">
            <span className="truncate">{activeLabel}</span>
            <button
              type="button"
              onClick={() => void cancelActive()}
              disabled={saving}
              className="inline-flex shrink-0 items-center gap-1 font-medium hover:underline disabled:opacity-50"
            >
              <X className="h-3 w-3" />
              {copy.cancel}
            </button>
          </div>
        )}

        <label className="mt-3 block text-[11px] font-medium text-muted-foreground" htmlFor="reminder-note">
          {copy.note}
        </label>
        <input
          id="reminder-note"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          maxLength={500}
          className="mt-1 h-8 w-full rounded-md border border-border bg-background px-2 text-xs text-foreground outline-none focus:ring-2 focus:ring-ring"
        />

        <div className="mt-3 grid gap-1">
          {REMINDER_PRESETS.map((preset) => (
            <button
              key={preset}
              type="button"
              disabled={busy}
              onClick={() => void create(reminderPresetTime(preset))}
              className="flex h-8 items-center justify-between rounded-md px-2 text-left text-xs text-popover-foreground transition-colors hover:bg-muted disabled:opacity-50"
            >
              {copy.presets[preset]}
              <span className="text-[11px] tabular-nums text-muted-foreground">
                {formatReminderWhen(reminderPresetTime(preset), language)}
              </span>
            </button>
          ))}
        </div>

        <form
          className="mt-3 border-t border-border pt-3"
          onSubmit={(e) => {
            e.preventDefault();
            const when = fromDateTimeLocal(custom);
            void create(when ? new Date(when) : new Date(NaN));
          }}
        >
          <label className="block text-[11px] font-medium text-muted-foreground" htmlFor="reminder-when">
            {copy.custom}
          </label>
          <div className="mt-1 flex items-center gap-1.5">
            <input
              id="reminder-when"
              type="datetime-local"
              value={custom}
              min={toDateTimeLocal(new Date().toISOString())}
              onChange={(e) => {
                setCustom(e.target.value);
                setError(null);
              }}
              className="h-8 min-w-0 flex-1 rounded-md border border-border bg-background px-2 text-xs text-foreground outline-none focus:ring-2 focus:ring-ring"
            />
            <button
              type="submit"
              disabled={busy || !custom}
              className="inline-flex h-8 shrink-0 items-center rounded-md bg-primary px-2.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
            >
              {saving || !statusesReady ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                copy.save
              )}
            </button>
          </div>
          {error && (
            <p role="alert" className="mt-1.5 text-[11px] text-destructive">
              {error}
            </p>
          )}
        </form>
      </PopoverContent>
    </Popover>
  );
}

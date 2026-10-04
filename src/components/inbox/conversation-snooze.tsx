"use client";

import { useCallback, useEffect, useId, useState } from "react";
import { Hourglass, Loader2, X } from "lucide-react";
import { toast } from "sonner";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useLanguage } from "@/hooks/use-language";
import type { Language } from "@/lib/i18n";
import { setRowSnooze } from "@/lib/inbox/row-actions";
import { INBOX_SHORTCUT_EVENT, type ShortcutAction } from "@/lib/inbox/shortcuts";
import {
  SNOOZE_MAX_AHEAD_MS,
  SNOOZE_MIN_AHEAD_MS,
  SNOOZE_NOTE_MAX,
  availableSnoozePresets,
  dispatchInboxSnoozed,
  formatSnoozeWhen,
  snoozeUndoPayload,
  validateSnoozeTime,
  type SnoozeDbError,
  type SnoozePreset,
  type SnoozeTimeError,
} from "@/lib/inbox/snooze";
import { activeSlaTarget } from "@/lib/support/sla";
import { createClient } from "@/lib/supabase/client";
import { fromDateTimeLocal, toDateTimeLocal } from "@/lib/tasks";
import { cn } from "@/lib/utils";
import type { Conversation } from "@/types";

/** Language-keyed (interpolated forms); the popover is `data-no-translate`. */
export const SNOOZE_COPY: Record<
  Language,
  {
    snooze: string;
    title: string;
    hint: string;
    rowAria: (name: string) => string;
    presets: Record<SnoozePreset, (when: Date) => string>;
    custom: string;
    note: string;
    noteCount: (n: number) => string;
    submit: string;
    active: (when: string) => string;
    cancel: string;
    snoozed: (when: string) => string;
    undo: string;
    cancelled: string;
    failed: string;
    readOnly: string;
    sla: (when: string) => string;
    errors: Record<SnoozeTimeError | Exclude<SnoozeDbError, "failed" | "out_of_range">, string>;
  }
> = {
  "pt-BR": {
    snooze: "Adiar",
    title: "Adiar conversa",
    hint: "A conversa sai das filas e volta sozinha no horário escolhido, ou antes, se o cliente responder.",
    rowAria: (name) => `Adiar conversa com ${name}`,
    presets: {
      in1h: () => "Daqui a 1 hora",
      laterToday: (when) => `Hoje às ${when.getHours()}h`,
      tomorrow9: () => "Amanhã às 9h",
      nextMonday9: () => "Próxima segunda às 9h",
    },
    custom: "Data e hora personalizadas",
    note: "Motivo (opcional)",
    noteCount: (n) => `${n}/${SNOOZE_NOTE_MAX}`,
    submit: "Adiar",
    active: (when) => `Adiada até ${when}`,
    cancel: "Cancelar adiamento",
    snoozed: (when) => `Adiada até ${when}`,
    undo: "Desfazer",
    cancelled: "Adiamento cancelado",
    failed: "Não foi possível adiar a conversa",
    readOnly: "Somente leitura — seu perfil não pode adiar conversas",
    sla: (when) => `O SLA continua correndo (prazo ${when}).`,
    errors: {
      invalid: "Escolha uma data e hora válidas",
      too_soon: "Escolha um horário daqui a pelo menos 1 minuto",
      too_far: "Escolha uma data dentro de um ano",
      not_live: "Conversas resolvidas ou arquivadas não podem ser adiadas",
    },
  },
  "en-US": {
    snooze: "Snooze",
    title: "Snooze conversation",
    hint: "The conversation leaves the queues and comes back on its own at the chosen time, or sooner if the customer replies.",
    rowAria: (name) => `Snooze conversation with ${name}`,
    presets: {
      in1h: () => "In 1 hour",
      laterToday: (when) => `Today at ${when.toLocaleTimeString("en-US", { hour: "numeric" })}`,
      tomorrow9: () => "Tomorrow at 9am",
      nextMonday9: () => "Next Monday at 9am",
    },
    custom: "Custom date and time",
    note: "Reason (optional)",
    noteCount: (n) => `${n}/${SNOOZE_NOTE_MAX}`,
    submit: "Snooze",
    active: (when) => `Snoozed until ${when}`,
    cancel: "Cancel snooze",
    snoozed: (when) => `Snoozed until ${when}`,
    undo: "Undo",
    cancelled: "Snooze cancelled",
    failed: "Could not snooze the conversation",
    readOnly: "Read-only — your role can't snooze conversations",
    sla: (when) => `The SLA keeps running (due ${when}).`,
    errors: {
      invalid: "Pick a valid date and time",
      too_soon: "Pick a time at least 1 minute from now",
      too_far: "Pick a date within a year",
      not_live: "Resolved or archived conversations can't be snoozed",
    },
  },
};

type SnoozeConversation = Pick<
  Conversation,
  | "id"
  | "status"
  | "archived_at"
  | "snoozed_until"
  | "snooze_note"
  | "first_response_at"
  | "first_response_due_at"
  | "first_response_warn_at"
  | "resolution_due_at"
  | "resolution_warn_at"
>;

/**
 * "Adiar" — the thread header button (variant "header", also opened by the
 * `h` shortcut and the palette) and the row quick action (variant "row").
 * Writes `snoozed_until` + `snooze_note` (the guard trigger does the rest),
 * then: Desfazer toast, local patch, and the list moves on when it was the
 * open conversation (`dispatchInboxSnoozed`).
 */
export function ConversationSnooze({
  conversation,
  contactName,
  disabled,
  variant = "header",
  listenShortcut = false,
  onOpenChange,
  onPatch,
}: {
  conversation: SnoozeConversation;
  contactName: string;
  /** Viewer (or role still loading): rendered, not clickable. */
  disabled: boolean;
  variant?: "header" | "row";
  /** Header only: open on the `h` shortcut / palette action. */
  listenShortcut?: boolean;
  onOpenChange?: (open: boolean) => void;
  onPatch?: (conversationId: string, patch: Partial<Conversation>) => void;
}) {
  const { language } = useLanguage();
  const copy = SNOOZE_COPY[language] ?? SNOOZE_COPY["pt-BR"];
  const ids = useId();
  const [open, setOpenState] = useState(false);
  const [note, setNote] = useState("");
  const [custom, setCustom] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // Read when the popover opens (presets / min / max are relative to it).
  const [openedAt, setOpenedAt] = useState(0);

  const setOpen = useCallback(
    (next: boolean) => {
      if (next && disabled) return;
      setOpenState(next);
      if (next) setOpenedAt(Date.now());
      else {
        setError(null);
        setCustom("");
        setNote("");
      }
      onOpenChange?.(next);
    },
    [disabled, onOpenChange],
  );

  useEffect(() => {
    if (!listenShortcut) return;
    const onShortcut = (e: Event) => {
      if ((e as CustomEvent<ShortcutAction>).detail === "snooze") setOpen(true);
    };
    window.addEventListener(INBOX_SHORTCUT_EVENT, onShortcut);
    return () => window.removeEventListener(INBOX_SHORTCUT_EVENT, onShortcut);
  }, [listenShortcut, setOpen]);

  const id = conversation.id;
  const snoozedUntil = conversation.snoozed_until ?? null;
  const snoozeNote = conversation.snooze_note ?? null;

  const write = useCallback(
    async (until: Date | null) => {
      if (until) {
        const problem = validateSnoozeTime(until);
        if (problem) {
          setError(copy.errors[problem]);
          return;
        }
      }
      setSaving(true);
      setError(null);
      const db = createClient();
      const result = await setRowSnooze(db, id, until ? until.toISOString() : null, until ? note : null);
      setSaving(false);
      if (result.status === "failed") {
        if (result.error === "not_live") setError(copy.errors.not_live);
        else if (result.error === "out_of_range")
          setError(
            until && until.getTime() - Date.now() > SNOOZE_MAX_AHEAD_MS / 2
              ? copy.errors.too_far
              : copy.errors.too_soon,
          );
        else toast.error(copy.failed);
        return;
      }
      setOpen(false);
      if (!until) {
        onPatch?.(id, result.row);
        toast.success(copy.cancelled);
        return;
      }
      // The list picks the next row before the patch drops this one.
      dispatchInboxSnoozed(id);
      onPatch?.(id, result.row);
      const undo = snoozeUndoPayload({ snoozed_until: snoozedUntil, snooze_note: snoozeNote });
      toast.success(copy.snoozed(formatSnoozeWhen(until, language)), {
        action: {
          label: copy.undo,
          onClick: () =>
            void setRowSnooze(db, id, undo.snoozed_until, undo.snooze_note).then((r) => {
              if (r.status === "ok") onPatch?.(id, r.row);
              else toast.error(copy.failed);
            }),
        },
      });
    },
    [id, note, copy, language, onPatch, setOpen, snoozedUntil, snoozeNote],
  );

  const activeLabel = snoozedUntil ? copy.active(formatSnoozeWhen(new Date(snoozedUntil), language)) : null;
  const triggerLabel = disabled
    ? copy.readOnly
    : variant === "row"
      ? copy.rowAria(contactName)
      : (activeLabel ?? copy.snooze);
  const presets = open ? availableSnoozePresets(openedAt) : [];
  const sla = activeSlaTarget(conversation);
  const errorId = `${ids}-error`;
  const noteId = `${ids}-note`;
  const whenId = `${ids}-when`;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        disabled={disabled}
        aria-label={triggerLabel}
        title={variant === "row" ? copy.snooze : triggerLabel}
        data-no-translate
        data-action={variant === "row" ? "snooze" : undefined}
        data-testid={variant === "header" ? "snooze-trigger" : undefined}
        className={
          variant === "row"
            ? "inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 data-popup-open:bg-muted data-popup-open:text-foreground"
            : cn(
                "inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-xs transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50 data-popup-open:bg-muted",
                snoozedUntil ? "text-primary" : "text-muted-foreground",
              )
        }
      >
        <Hourglass className="size-3.5" aria-hidden />
        {variant === "header" && (
          <span className="hidden max-w-36 truncate @2xl:inline">{activeLabel ?? copy.snooze}</span>
        )}
      </PopoverTrigger>
      <PopoverContent
        align="end"
        data-no-translate
        aria-label={copy.title}
        className="w-72 border-border bg-popover p-3"
      >
        <p className="text-sm font-medium text-popover-foreground">{copy.title}</p>
        <p className="mt-0.5 text-[11px] leading-4 text-muted-foreground">{copy.hint}</p>

        {activeLabel && (
          <div className="mt-2 flex items-center justify-between gap-2 rounded-md bg-primary/10 px-2 py-1.5 text-xs text-primary">
            <span className="truncate" title={snoozeNote ?? undefined}>
              {activeLabel}
            </span>
            <button
              type="button"
              onClick={() => void write(null)}
              disabled={saving}
              className="inline-flex shrink-0 items-center gap-1 rounded font-medium hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
            >
              <X className="size-3" aria-hidden />
              {copy.cancel}
            </button>
          </div>
        )}

        <div className="mt-3 flex items-baseline justify-between">
          <label className="text-[11px] font-medium text-muted-foreground" htmlFor={noteId}>
            {copy.note}
          </label>
          <span aria-live="polite" className="text-[10px] tabular-nums text-muted-foreground">
            {note ? copy.noteCount(note.length) : ""}
          </span>
        </div>
        <input
          id={noteId}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          maxLength={SNOOZE_NOTE_MAX}
          className="mt-1 h-8 w-full rounded-md border border-border bg-background px-2 text-xs text-foreground outline-none focus:ring-2 focus:ring-ring"
        />

        <div className="mt-3 grid gap-1">
          {presets.map(({ preset, when }) => {
            const label = copy.presets[preset](when);
            const whenText = formatSnoozeWhen(when, language, openedAt);
            return (
              <button
                key={preset}
                type="button"
                disabled={saving}
                data-preset={preset}
                aria-label={`${label} · ${when.toLocaleString(language, { weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" })}`}
                onClick={() => void write(when)}
                className="flex h-8 items-center justify-between rounded-md px-2 text-left text-xs text-popover-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
              >
                {label}
                <span className="text-[11px] tabular-nums text-muted-foreground">{whenText}</span>
              </button>
            );
          })}
        </div>

        <form
          className="mt-3 border-t border-border pt-3"
          onSubmit={(e) => {
            e.preventDefault();
            const iso = fromDateTimeLocal(custom);
            void write(iso ? new Date(iso) : new Date(NaN));
          }}
        >
          <label className="block text-[11px] font-medium text-muted-foreground" htmlFor={whenId}>
            {copy.custom}
          </label>
          <div className="mt-1 flex items-center gap-1.5">
            <input
              id={whenId}
              type="datetime-local"
              value={custom}
              min={open ? toDateTimeLocal(new Date(openedAt + SNOOZE_MIN_AHEAD_MS).toISOString()) : undefined}
              max={open ? toDateTimeLocal(new Date(openedAt + SNOOZE_MAX_AHEAD_MS).toISOString()) : undefined}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? errorId : undefined}
              onChange={(e) => {
                setCustom(e.target.value);
                setError(null);
              }}
              className="h-8 min-w-0 flex-1 rounded-md border border-border bg-background px-2 text-xs text-foreground outline-none focus:ring-2 focus:ring-ring"
            />
            <button
              type="submit"
              disabled={saving || !custom}
              className="inline-flex h-8 shrink-0 items-center rounded-md bg-primary px-2.5 text-xs font-medium text-primary-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
            >
              {saving ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : copy.submit}
            </button>
          </div>
          {error && (
            <p id={errorId} role="alert" className="mt-1.5 text-[11px] text-destructive">
              {error}
            </p>
          )}
        </form>

        {sla && sla.dueAt > openedAt && (
          <p className="mt-2 text-[11px] leading-4 text-muted-foreground">
            {copy.sla(formatSnoozeWhen(new Date(sla.dueAt), language, openedAt))}
          </p>
        )}
      </PopoverContent>
    </Popover>
  );
}

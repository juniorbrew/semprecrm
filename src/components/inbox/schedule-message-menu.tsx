"use client";

import { useState } from "react";
import { CalendarClock, ChevronDown, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import {
  formatScheduledAt,
  parseLocalInput,
  schedulePresets,
  toLocalInputValue,
  validateScheduleAt,
} from "@/lib/scheduled-messages/schedule";
import type { Language } from "@/lib/i18n";
import { SCHEDULED_COPY } from "./scheduled-copy";

interface ScheduleMessageMenuProps {
  language: Language;
  /** No text typed / read-only / expired: the trigger is disabled with a hint. */
  disabled: boolean;
  disabledReason?: string;
  /** Resolves when the server accepted the schedule; rejects with a message to show inline. */
  onSchedule: (at: Date) => Promise<void>;
  /** Clock injection point for tests. */
  now?: () => Date;
}

/** "Agendar" next to Send: presets plus a custom date/time (viewer's local time). */
export function ScheduleMessageMenu({
  language,
  disabled,
  disabledReason,
  onSchedule,
  now = () => new Date(),
}: ScheduleMessageMenuProps) {
  const copy = SCHEDULED_COPY[language] ?? SCHEDULED_COPY["pt-BR"];
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const current = open ? now() : null;
  const presets = current ? schedulePresets(current) : [];
  const tz = typeof Intl !== "undefined" ? Intl.DateTimeFormat().resolvedOptions().timeZone : "";

  async function submit(at: Date | null) {
    const check = validateScheduleAt(at, now());
    if (!check.ok) {
      setError(copy.errors[check.code]);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSchedule(check.date);
      setOpen(false);
      setCustom("");
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : copy.genericError);
    } finally {
      setBusy(false);
    }
  }

  const min = current ? toLocalInputValue(new Date(current.getTime() + 60_000)) : undefined;

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setError(null);
      }}
    >
      <PopoverTrigger
        disabled={disabled}
        data-testid="schedule-trigger"
        data-no-translate
        aria-label={disabled && disabledReason ? disabledReason : copy.scheduleTitle}
        title={disabled && disabledReason ? disabledReason : copy.scheduleTitle}
        className="inline-flex h-8 shrink-0 items-center gap-1 rounded-md border border-border px-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
      >
        <CalendarClock className="h-4 w-4" aria-hidden />
        <span className="hidden sm:inline">{copy.schedule}</span>
        <ChevronDown className="h-3 w-3" aria-hidden />
      </PopoverTrigger>
      <PopoverContent align="end" side="top" data-no-translate className="w-72 gap-2">
        <p className="px-1 text-xs font-medium text-muted-foreground">{copy.menuTitle}</p>
        <div className="flex flex-col" role="menu">
          {presets.map((p) => (
            <button
              key={p.key}
              type="button"
              role="menuitem"
              disabled={busy}
              onClick={() => void submit(p.at)}
              className="flex items-center justify-between rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-muted disabled:opacity-50"
            >
              <span>{copy.presets[p.key]}</span>
              <span className="text-xs text-muted-foreground">
                {formatScheduledAt(p.at, current ?? p.at, language)}
              </span>
            </button>
          ))}
        </div>
        <div className="border-t border-border pt-2">
          <label htmlFor="schedule-custom" className="px-1 text-xs font-medium text-muted-foreground">
            {copy.custom}
          </label>
          <input
            id="schedule-custom"
            type="datetime-local"
            value={custom}
            min={min}
            onChange={(e) => {
              setCustom(e.target.value);
              setError(null);
            }}
            className={cn(
              "mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm outline-none focus:border-primary/60",
              error ? "border-destructive" : "border-input",
            )}
          />
          <p className="mt-1 px-1 text-[11px] text-muted-foreground">
            {copy.customHint}
            {tz ? ` · ${copy.timezoneNote(tz)}` : ""}
          </p>
        </div>
        {error && (
          <p role="alert" className="px-1 text-xs text-destructive">
            {error}
          </p>
        )}
        <Button
          size="sm"
          disabled={busy || !custom}
          onClick={() => void submit(parseLocalInput(custom))}
          className="w-full"
        >
          {busy ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <CalendarClock className="mr-1.5 h-4 w-4" />}
          {busy ? copy.scheduling : copy.confirm}
        </Button>
      </PopoverContent>
    </Popover>
  );
}

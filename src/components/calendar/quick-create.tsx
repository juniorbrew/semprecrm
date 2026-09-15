"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { CalendarClock, Loader2, SlidersHorizontal } from "lucide-react";
import { toast } from "sonner";

import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { useLanguage } from "@/hooks/use-language";
import {
  allDayRange,
  createEvent,
  fromZonedInputValue,
  toZonedDateValue,
  toZonedInputValue,
  type CalendarContactRef,
  type CalendarEvent,
  type CalendarEventInput,
} from "@/lib/calendar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

import { ContactPicker } from "./contact-picker";
import { useCalendarTimezone } from "./hooks";

export interface QuickCreateDraft {
  starts_at: string;
  ends_at: string;
  all_day: boolean;
}

export interface QuickCreateProps {
  /** The slot the click / drag produced. */
  draft: QuickCreateDraft;
  /**
   * Links and other prefills — the inbox passes `{ contact_id,
   * conversation_id }`, a deal `{ deal_id, contact_id }`, …
   */
  defaults?: Partial<CalendarEventInput>;
  /** Show the contact search (the /agenda grid); panels already know the contact. */
  withContact?: boolean;
  /** Screen position (grid popover). Omit to render inline in a panel. */
  anchor?: { x: number; y: number } | null;
  onCreated?: (event: CalendarEvent) => void;
  /** "More options" → the parent opens the full drawer with this draft. */
  onMoreOptions?: (draft: Partial<CalendarEventInput>) => void;
  onCancel: () => void;
  className?: string;
}

const WIDTH = 320;

/**
 * Compact "title + when (+ contact)" creator: Enter or "Create" saves,
 * Esc / Cancel collapses, "More options" hands the draft to the full
 * drawer. Positioned next to the click on the grid, or inline inside a
 * side panel's "Agenda" section.
 */
export function QuickCreate({
  draft,
  defaults,
  withContact,
  anchor,
  onCreated,
  onMoreOptions,
  onCancel,
  className,
}: QuickCreateProps) {
  const { t } = useLanguage();
  const { accountId, user } = useAuth();
  const tz = useCalendarTimezone();
  const supabase = useMemo(() => createClient(), []);

  const [title, setTitle] = useState(defaults?.title ?? "");
  const [allDay, setAllDay] = useState(draft.all_day);
  const [startLocal, setStartLocal] = useState(() => toZonedInputValue(draft.starts_at, tz));
  const [endLocal, setEndLocal] = useState(() => toZonedInputValue(draft.ends_at, tz));
  const [date, setDate] = useState(() => toZonedDateValue(draft.starts_at, tz));
  const [contact, setContact] = useState<CalendarContactRef | null>(null);
  const [saving, setSaving] = useState(false);

  const range = useMemo(() => {
    if (allDay) {
      const s = fromZonedInputValue(date, tz);
      return s ? allDayRange(new Date(s), new Date(s), tz) : null;
    }
    const s = fromZonedInputValue(startLocal, tz);
    const e = fromZonedInputValue(endLocal, tz);
    if (!s || !e || new Date(e).getTime() <= new Date(s).getTime()) return null;
    return { starts_at: s, ends_at: e };
  }, [allDay, date, startLocal, endLocal, tz]);

  const canSave = !!title.trim() && !!range && !saving;

  function build(): Partial<CalendarEventInput> {
    return {
      ...defaults,
      title: title.trim(),
      all_day: allDay,
      ...(range ?? {}),
      contact_id: contact?.id ?? defaults?.contact_id ?? null,
    };
  }

  async function save() {
    if (!canSave || !range) return;
    if (!accountId) {
      toast.error(t("Your profile is not linked to an account."));
      return;
    }
    setSaving(true);
    try {
      const created = await createEvent(
        supabase,
        { accountId, userId: user?.id ?? null },
        { ...build(), title: title.trim(), starts_at: range.starts_at, ends_at: range.ends_at },
      );
      toast.success(t("Appointment created"));
      onCreated?.(created);
      onCancel();
    } catch (err) {
      console.error("[calendar] quick create:", err);
      toast.error(t("Failed to create appointment"));
    } finally {
      setSaving(false);
    }
  }

  // Esc anywhere inside closes.
  const rootRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!anchor) return;
    const onDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) onCancel();
    };
    // Delay so the pointerup that opened us does not close us.
    const id = setTimeout(() => document.addEventListener("pointerdown", onDown), 0);
    return () => {
      clearTimeout(id);
      document.removeEventListener("pointerdown", onDown);
    };
  }, [anchor, onCancel]);

  // Keep the popover inside the viewport.
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    if (!anchor) return;
    const h = rootRef.current?.offsetHeight ?? 220;
    const left = Math.max(8, Math.min(anchor.x + 8, window.innerWidth - WIDTH - 8));
    const top = Math.max(8, Math.min(anchor.y + 8, window.innerHeight - h - 8));
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPos({ left, top });
  }, [anchor, allDay]);

  const inputClass = "h-7 rounded-md border border-transparent bg-background/60 px-1.5 text-[11px] text-foreground outline-none focus:border-primary";

  return (
    <div
      ref={rootRef}
      role="dialog"
      aria-label={t("New appointment")}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          onCancel();
        }
      }}
      style={anchor ? { position: "fixed", width: WIDTH, left: pos?.left ?? anchor.x, top: pos?.top ?? anchor.y, zIndex: 40 } : undefined}
      className={cn(
        anchor
          ? "rounded-xl border border-border bg-popover p-3 text-popover-foreground shadow-xl"
          : className ?? "rounded-lg border border-dashed border-primary/40 bg-primary/5 p-2",
      )}
    >
      <Input
        value={title}
        autoFocus
        disabled={saving}
        placeholder={t("Appointment title")}
        aria-label={t("Title")}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void save();
          }
        }}
        className="h-8 border-transparent bg-background/60 text-xs text-foreground md:text-xs"
      />
      <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1.5 text-[11px] text-muted-foreground">
        <CalendarClock className="h-3.5 w-3.5" />
        {allDay ? (
          <input type="date" value={date} disabled={saving} aria-label={t("Start")} onChange={(e) => setDate(e.target.value)} className={inputClass} />
        ) : (
          <>
            <input
              type="datetime-local"
              value={startLocal}
              disabled={saving}
              aria-label={t("Start")}
              onChange={(e) => {
                const prev = fromZonedInputValue(startLocal, tz);
                const next = fromZonedInputValue(e.target.value, tz);
                const end = fromZonedInputValue(endLocal, tz);
                setStartLocal(e.target.value);
                if (prev && next && end) {
                  const len = new Date(end).getTime() - new Date(prev).getTime();
                  if (len > 0) setEndLocal(toZonedInputValue(new Date(new Date(next).getTime() + len).toISOString(), tz));
                }
              }}
              className={inputClass}
            />
            <span>–</span>
            <input
              type="time"
              value={endLocal.slice(11, 16)}
              disabled={saving}
              aria-label={t("End")}
              onChange={(e) => setEndLocal(`${startLocal.slice(0, 10)}T${e.target.value}`)}
              className={inputClass}
            />
          </>
        )}
        <label className="ml-auto inline-flex items-center gap-1">
          <input type="checkbox" checked={allDay} disabled={saving} onChange={(e) => setAllDay(e.target.checked)} className="h-3 w-3 accent-primary" />
          {t("All day")}
        </label>
      </div>
      {withContact && (
        <div className="mt-2">
          <ContactPicker contact={contact} disabled={saving} onChange={setContact} compact />
        </div>
      )}
      <div className="mt-2 flex items-center justify-between gap-2">
        {onMoreOptions ? (
          <button
            type="button"
            disabled={saving}
            onClick={() => {
              onMoreOptions(build());
              onCancel();
            }}
            className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
          >
            <SlidersHorizontal className="h-3 w-3" />
            {t("More options")}
          </button>
        ) : (
          <span />
        )}
        <div className="flex items-center gap-1">
          <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={saving} className="h-7 px-2 text-xs text-muted-foreground hover:bg-muted">
            {t("Cancel")}
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={() => void save()}
            disabled={!canSave}
            className="h-7 bg-primary px-2.5 text-xs text-primary-foreground hover:bg-primary/90"
          >
            {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : t("Create")}
          </Button>
        </div>
      </div>
    </div>
  );
}

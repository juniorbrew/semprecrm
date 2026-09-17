"use client";

import Link from "next/link";
import { useState } from "react";
import { CalendarDays, Loader2, Plus } from "lucide-react";

import { useLanguage } from "@/hooks/use-language";
import { eventHref, formatEventRange, type CalendarEvent, type CalendarEventInput, type EventLinkFilter } from "@/lib/calendar";
import { cn } from "@/lib/utils";

import { chipStyle, eventColor } from "./colors";
import { EventDrawer } from "./event-drawer";
import { useCalendarTimezone, useLinkedEvents } from "./hooks";
import { QuickCreate, type QuickCreateDraft } from "./quick-create";

/** A one-hour slot from now, rounded up to the next half hour. */
function nextSlot(): QuickCreateDraft {
  const step = 30 * 60_000;
  const start = Math.ceil(Date.now() / step) * step;
  return { starts_at: new Date(start).toISOString(), ends_at: new Date(start + 3_600_000).toISOString(), all_day: false };
}

export interface LinkedEventsProps extends EventLinkFilter {
  /** Prefill for the inline "+" and the drawer (links + title). */
  defaults?: Partial<CalendarEventInput>;
  /** Hide the "+" (viewer role, module off for writing, …). */
  readOnly?: boolean;
  /** Render the section header (icon + label + count + "+"). Default true. */
  withHeader?: boolean;
  /** Override the header label (default "Calendar"). */
  label?: string;
  /** Header markup variant: the inbox panel uses uppercase tiny labels like its other sections. */
  headerClassName?: string;
  /** Extra classes on the list / quick-add wrapper (panel gutters). */
  bodyClassName?: string;
  className?: string;
  /** Called after a create from this section (e.g. to bump a counter). */
  onCreated?: (event: CalendarEvent) => void;
}

/**
 * "Agenda" section for a side panel: the next three appointments of a
 * contact / conversation / deal / task / chat thread, an inline "+"
 * quick-add (title + when) prefilled with the links, and the drawer
 * on click. Kept live through the calendar realtime channel.
 */
export function LinkedEvents({
  contactId,
  conversationId,
  dealId,
  taskId,
  chatThreadId,
  defaults,
  readOnly,
  withHeader = true,
  label,
  headerClassName,
  bodyClassName,
  className,
  onCreated,
}: LinkedEventsProps) {
  const { t, language } = useLanguage();
  const tz = useCalendarTimezone();
  const linked = useLinkedEvents({ contactId, conversationId, dealId, taskId, chatThreadId });
  // The quick-add's slot is computed when "+" is pressed (not during render).
  const [addDraft, setAddDraft] = useState<QuickCreateDraft | null>(null);
  const [drawerEvent, setDrawerEvent] = useState<CalendarEvent | null>(null);
  const [drawerDefaults, setDrawerDefaults] = useState<Partial<CalendarEventInput> | undefined>(undefined);
  const [drawerOpen, setDrawerOpen] = useState(false);

  const linkDefaults: Partial<CalendarEventInput> = {
    contact_id: contactId ?? undefined,
    conversation_id: conversationId ?? undefined,
    deal_id: dealId ?? undefined,
    task_id: taskId ?? undefined,
    chat_thread_id: chatThreadId ?? undefined,
    ...defaults,
  };

  return (
    <div className={className}>
      {withHeader && (
        <div className={cn("flex items-center justify-between gap-2", headerClassName)}>
          <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            <CalendarDays className="h-3 w-3" />
            <span>{label ?? t("Calendar")}</span>
            {linked.events.length > 0 && (
              <span className="rounded-full bg-muted px-1.5 text-[10px] font-semibold tabular-nums">{linked.events.length}</span>
            )}
          </div>
          {!readOnly && (
            <button
              type="button"
              aria-label={t("Schedule appointment")}
              title={t("Schedule appointment")}
              onClick={() => setAddDraft((d) => (d ? null : nextSlot()))}
              className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      )}
      <div className={cn("space-y-2", withHeader && "mt-2", bodyClassName)}>
        {addDraft && (
          <QuickCreate
            draft={addDraft}
            defaults={linkDefaults}
            onCreated={(ev) => {
              linked.patch(ev);
              onCreated?.(ev);
            }}
            onMoreOptions={(draft) => {
              setDrawerEvent(null);
              setDrawerDefaults({ ...linkDefaults, ...draft });
              setDrawerOpen(true);
            }}
            onCancel={() => setAddDraft(null)}
          />
        )}
        {linked.events.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            {linked.loading ? (
              <span className="inline-flex items-center gap-1">
                <Loader2 className="h-3 w-3 animate-spin" /> {t("Loading...")}
              </span>
            ) : (
              t("No upcoming appointments")
            )}
          </p>
        ) : (
          <ul className="space-y-1">
            {linked.events.map((ev) => (
              <li key={ev.id}>
                <button
                  type="button"
                  onClick={() => {
                    setDrawerEvent(ev);
                    setDrawerDefaults(undefined);
                    setDrawerOpen(true);
                  }}
                  style={chipStyle(eventColor(ev))}
                  className="flex w-full items-start gap-2 rounded-lg border-l-[3px] px-2 py-1.5 text-left transition-opacity hover:opacity-90"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-medium">{ev.title}</span>
                    <span className="block truncate text-[11px] opacity-80">
                      {formatEventRange(ev, language, tz, { withDate: true, allDayLabel: t("All day") })}
                      {ev.location ? ` · ${ev.location}` : ""}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {linked.events.length > 0 && (
          <Link
            href={eventHref(linked.events[0].id)}
            className="inline-flex items-center gap-1 text-[11px] text-primary hover:underline"
          >
            {t("Open in Calendar")}
          </Link>
        )}
      </div>
      <EventDrawer
        open={drawerOpen}
        onOpenChange={setDrawerOpen}
        event={drawerEvent}
        defaults={drawerEvent ? undefined : drawerDefaults}
        onCreated={(ev) => {
          linked.patch(ev);
          onCreated?.(ev);
        }}
        onUpdated={linked.patch}
        onDeleted={linked.remove}
      />
    </div>
  );
}

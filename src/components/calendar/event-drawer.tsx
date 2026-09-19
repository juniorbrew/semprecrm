"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Ban,
  Bell,
  CalendarDays,
  Check,
  CheckSquare,
  ExternalLink,
  GitBranch,
  Loader2,
  MapPin,
  MessageSquare,
  MessagesSquare,
  RotateCcw,
  Search,
  Trash2,
  User,
  Users,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { createClient } from "@/lib/supabase/client";
import { useAuth, useEntitlements } from "@/hooks/use-auth";
import { useLanguage } from "@/hooks/use-language";
import {
  EVENT_LINK_LABELS,
  REMINDER_LABELS,
  REMINDER_OPTIONS,
  addDaysIn,
  allDayRange,
  cancelEvent,
  createEvent,
  deleteEvent,
  findConflicts,
  formatEventRange,
  fromZonedInputValue,
  isReminderMinutes,
  linkHref,
  listEventsInRange,
  respondToEvent,
  restoreEvent,
  startOfDayIn,
  toZonedDateValue,
  toZonedInputValue,
  updateEvent,
  type CalendarAttendeeResponse,
  type CalendarContactRef,
  type CalendarEvent,
  type CalendarEventInput,
  type CalendarMember,
  type CalendarTaskRef,
  type ReminderMinutes,
} from "@/lib/calendar";
import { listMyThreads, otherMemberId } from "@/lib/chat";
import type { ChatThread } from "@/types";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

import { EVENT_COLORS, colorForUser } from "./colors";
import { ContactPicker } from "./contact-picker";
import { memberName, useCalendarMembers, useCalendarTimezone } from "./hooks";
import { timezoneLabel } from "./timezone-label";
import { ProviderIcon } from "./provider-icon";

const SELECT_CLASS =
  "h-8 w-full rounded-lg border border-border bg-muted px-2.5 text-sm text-foreground outline-none focus:border-primary focus:ring-1 focus:ring-primary disabled:cursor-not-allowed disabled:opacity-60";

export interface EventDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Existing event → edit; `null` → create form. */
  event: CalendarEvent | null;
  /**
   * Prefill for create mode — `{ contact_id, conversation_id }` from
   * the inbox, `{ deal_id, contact_id }` from a deal, `{ task_id,
   * title, contact_id }` from a task, `{ chat_thread_id, title,
   * attendee_user_ids }` from a chat message. Ignored in edit mode.
   */
  defaults?: Partial<CalendarEventInput>;
  /** Pass when the parent already holds them; otherwise the drawer loads them. */
  members?: CalendarMember[];
  /**
   * Task drawer only: show "also set the task's due date to the
   * start" and report the choice in `onCreated`.
   */
  offerTaskDue?: boolean;
  onCreated?: (event: CalendarEvent, extras: { setTaskDue: boolean }) => void;
  onUpdated?: (event: CalendarEvent) => void;
  onDeleted?: (eventId: string) => void;
}

/**
 * Right-hand sheet for one appointment: title, when (with all-day),
 * where, notes, owner, attendees (with each answer), reminder,
 * colour and the links to the rest of the CRM — every link opens its
 * screen. Explicit Save; Cancel appointment / Restore and a guarded
 * Delete in the footer; a schedule-conflict note for the owner.
 */
export function EventDrawer({
  open,
  onOpenChange,
  event,
  defaults,
  members: membersProp,
  offerTaskDue,
  onCreated,
  onUpdated,
  onDeleted,
}: EventDrawerProps) {
  const own = useCalendarMembers({ enabled: !membersProp && open });
  const members = membersProp ?? own.members;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full border-border bg-popover p-0 text-popover-foreground data-[side=right]:sm:max-w-[540px]"
        aria-describedby={undefined}
      >
        {open && (
          <EventDrawerBody
            key={event?.id ?? "new"}
            event={event}
            defaults={defaults}
            members={members}
            offerTaskDue={offerTaskDue}
            onClose={() => onOpenChange(false)}
            onCreated={onCreated}
            onUpdated={onUpdated}
            onDeleted={onDeleted}
          />
        )}
      </SheetContent>
    </Sheet>
  );
}

// ------------------------------------------------------------
// Body
// ------------------------------------------------------------

interface BodyProps {
  event: CalendarEvent | null;
  defaults?: Partial<CalendarEventInput>;
  members: CalendarMember[];
  offerTaskDue?: boolean;
  onClose: () => void;
  onCreated?: (event: CalendarEvent, extras: { setTaskDue: boolean }) => void;
  onUpdated?: (event: CalendarEvent) => void;
  onDeleted?: (eventId: string) => void;
}

interface ConversationOption {
  id: string;
  status: string | null;
  last_message_at: string | null;
  created_at: string;
}

interface DealOption {
  id: string;
  title: string;
  status: string | null;
}

/** Default one-hour slot from now, rounded up to the next half hour. */
function defaultSlot(): { starts_at: string; ends_at: string } {
  const step = 30 * 60_000;
  const start = Math.ceil(Date.now() / step) * step;
  return { starts_at: new Date(start).toISOString(), ends_at: new Date(start + 60 * 60_000).toISOString() };
}

function EventDrawerBody({ event, defaults, members, offerTaskDue, onClose, onCreated, onUpdated, onDeleted }: BodyProps) {
  const supabase = useMemo(() => createClient(), []);
  const { t, language } = useLanguage();
  const { accountId, user, canSendMessages, canManageMembers } = useAuth();
  const { modules } = useEntitlements();
  const tz = useCalendarTimezone();
  const me = user?.id ?? null;
  const isEdit = !!event;

  // Who may change this row (mirrors the RLS in 040).
  const canEdit =
    canSendMessages &&
    (!isEdit || event.owner_user_id === me || event.created_by === me || canManageMembers);
  const readOnly = !canEdit;

  // ---- form state -------------------------------------------------
  const seed = useMemo(() => {
    if (event) return { starts_at: event.starts_at, ends_at: event.ends_at };
    if (defaults?.starts_at && defaults?.ends_at) return { starts_at: defaults.starts_at, ends_at: defaults.ends_at };
    return defaultSlot();
  }, [event, defaults?.starts_at, defaults?.ends_at]);

  const [title, setTitle] = useState(event?.title ?? defaults?.title ?? "");
  const [description, setDescription] = useState(event?.description ?? defaults?.description ?? "");
  const [location, setLocation] = useState(event?.location ?? defaults?.location ?? "");
  const [allDay, setAllDay] = useState(event?.all_day ?? defaults?.all_day ?? false);
  const [startLocal, setStartLocal] = useState(() => toZonedInputValue(seed.starts_at, tz));
  const [endLocal, setEndLocal] = useState(() => toZonedInputValue(seed.ends_at, tz));
  // All-day: the last covered day (inclusive) for the date input.
  const [startDate, setStartDate] = useState(() => toZonedDateValue(seed.starts_at, tz));
  const [endDate, setEndDate] = useState(() =>
    toZonedDateValue(new Date(new Date(seed.ends_at).getTime() - 1).toISOString(), tz),
  );
  const [owner, setOwner] = useState<string>(
    event ? (event.owner_user_id ?? "") : defaults?.owner_user_id === undefined ? (me ?? "") : (defaults.owner_user_id ?? ""),
  );
  const [attendees, setAttendees] = useState<string[]>(
    event ? (event.attendees ?? []).map((a) => a.user_id) : (defaults?.attendee_user_ids ?? []),
  );
  const [reminder, setReminder] = useState<ReminderMinutes | null>(
    event ? (isReminderMinutes(event.reminder_minutes) ? event.reminder_minutes : null) : (defaults?.reminder_minutes ?? null),
  );
  const [color, setColor] = useState<string>(event?.color ?? defaults?.color ?? "");
  const [contact, setContact] = useState<CalendarContactRef | null>(event?.contact ?? null);
  const [contactId, setContactId] = useState(event?.contact_id ?? defaults?.contact_id ?? "");
  const [conversationId, setConversationId] = useState(event?.conversation_id ?? defaults?.conversation_id ?? "");
  const [dealId, setDealId] = useState(event?.deal_id ?? defaults?.deal_id ?? "");
  const [task, setTask] = useState<CalendarTaskRef | null>(event?.task ?? null);
  const [taskId, setTaskId] = useState(event?.task_id ?? defaults?.task_id ?? "");
  const [chatThreadId, setChatThreadId] = useState(event?.chat_thread_id ?? defaults?.chat_thread_id ?? "");
  const [setTaskDue, setSetTaskDue] = useState(false);

  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState<"cancel" | "restore" | "delete" | "respond" | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // ---- link data --------------------------------------------------
  const [conversations, setConversations] = useState<ConversationOption[]>([]);
  const [deals, setDeals] = useState<DealOption[]>([]);
  const [threads, setThreads] = useState<ChatThread[]>([]);

  // Resolve a prefilled contact / task into a chip.
  useEffect(() => {
    if (contact || !contactId) return;
    let cancelled = false;
    supabase
      .from("contacts")
      .select("id, name, phone, avatar_url")
      .eq("id", contactId)
      .maybeSingle()
      .then(({ data }) => {
        if (!cancelled && data) setContact(data as CalendarContactRef);
      });
    return () => {
      cancelled = true;
    };
  }, [contact, contactId, supabase]);

  useEffect(() => {
    if (task || !taskId) return;
    let cancelled = false;
    supabase
      .from("tasks")
      .select("id, title")
      .eq("id", taskId)
      .maybeSingle()
      .then(({ data }) => {
        if (!cancelled && data) setTask(data as CalendarTaskRef);
      });
    return () => {
      cancelled = true;
    };
  }, [task, taskId, supabase]);

  // The contact's conversations and deals feed the two selects.
  useEffect(() => {
    if (!contactId) {
      setConversations([]);
      setDeals([]);
      return;
    }
    let cancelled = false;
    (async () => {
      const [c, d] = await Promise.all([
        supabase
          .from("conversations")
          .select("id, status, last_message_at, created_at")
          .eq("contact_id", contactId)
          .order("last_message_at", { ascending: false, nullsFirst: false })
          .limit(20),
        supabase.from("deals").select("id, title, status").eq("contact_id", contactId).order("created_at", { ascending: false }).limit(20),
      ]);
      if (cancelled) return;
      setConversations((c.data ?? []) as ConversationOption[]);
      setDeals((d.data ?? []) as DealOption[]);
    })();
    return () => {
      cancelled = true;
    };
  }, [contactId, supabase]);

  const chatEnabled = modules.internal_chat;
  useEffect(() => {
    if (!chatEnabled) return;
    let cancelled = false;
    listMyThreads(supabase)
      .then((rows) => {
        if (!cancelled) setThreads(rows);
      })
      .catch((err) => console.error("[calendar] threads:", err));
    return () => {
      cancelled = true;
    };
  }, [chatEnabled, supabase]);

  // ---- derived range ---------------------------------------------
  const range = useMemo(() => {
    if (allDay) {
      const s = fromZonedInputValue(startDate, tz);
      const e = fromZonedInputValue(endDate || startDate, tz);
      if (!s) return null;
      return allDayRange(new Date(s), new Date(e ?? s), tz);
    }
    const s = fromZonedInputValue(startLocal, tz);
    const e = fromZonedInputValue(endLocal, tz);
    if (!s || !e) return null;
    return { starts_at: s, ends_at: e };
  }, [allDay, startDate, endDate, startLocal, endLocal, tz]);
  const rangeInvalid = !!range && new Date(range.ends_at).getTime() <= new Date(range.starts_at).getTime();

  // Keep the end after the start when the start moves (same duration).
  const lastStart = useRef(startLocal);
  useEffect(() => {
    if (allDay || lastStart.current === startLocal) return;
    const prev = fromZonedInputValue(lastStart.current, tz);
    const next = fromZonedInputValue(startLocal, tz);
    const end = fromZonedInputValue(endLocal, tz);
    lastStart.current = startLocal;
    if (!prev || !next || !end) return;
    const len = new Date(end).getTime() - new Date(prev).getTime();
    if (len > 0) {
      setEndLocal(toZonedInputValue(new Date(new Date(next).getTime() + len).toISOString(), tz));
    }
  }, [startLocal, endLocal, allDay, tz]);

  // ---- conflicts (owner's other events overlapping the range) -------
  const [conflicts, setConflicts] = useState<CalendarEvent[]>([]);
  useEffect(() => {
    if (!range || rangeInvalid || allDay || !owner) {
      setConflicts([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const rows = await listEventsInRange(supabase, {
          accountId,
          from: range.starts_at,
          to: range.ends_at,
          ownerUserId: owner,
        });
        if (cancelled) return;
        setConflicts(
          findConflicts({ id: event?.id ?? null, owner_user_id: owner, starts_at: range.starts_at, ends_at: range.ends_at }, rows),
        );
      } catch {
        if (!cancelled) setConflicts([]);
      }
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [range, rangeInvalid, allDay, owner, accountId, supabase, event?.id]);

  // ---- actions ----------------------------------------------------
  function buildInput(): CalendarEventInput | null {
    if (!range) return null;
    return {
      title: title.trim(),
      description,
      location,
      color: color || null,
      starts_at: range.starts_at,
      ends_at: range.ends_at,
      all_day: allDay,
      owner_user_id: owner || null,
      reminder_minutes: reminder,
      contact_id: contactId || null,
      conversation_id: conversationId || null,
      deal_id: dealId || null,
      task_id: taskId || null,
      chat_thread_id: chatThreadId || null,
      attendee_user_ids: attendees,
    };
  }

  async function handleSave() {
    const input = buildInput();
    if (!input || !input.title || rangeInvalid || readOnly) return;
    if (!accountId) {
      toast.error(t("Your profile is not linked to an account."));
      return;
    }
    setSaving(true);
    try {
      if (isEdit) {
        const updated = await updateEvent(supabase, event, input);
        toast.success(t("Appointment saved"));
        onUpdated?.(updated);
      } else {
        const created = await createEvent(supabase, { accountId, userId: me }, input);
        toast.success(t("Appointment created"));
        onCreated?.(created, { setTaskDue: !!offerTaskDue && setTaskDue });
      }
      onClose();
    } catch (err) {
      console.error("[calendar] save:", err);
      toast.error(isEdit ? t("Failed to save appointment") : t("Failed to create appointment"));
    } finally {
      setSaving(false);
    }
  }

  async function handleCancelEvent() {
    if (!event) return;
    setBusy("cancel");
    try {
      const updated = await cancelEvent(supabase, event);
      toast.success(t("Appointment cancelled"));
      onUpdated?.(updated);
      onClose();
    } catch (err) {
      console.error("[calendar] cancel:", err);
      toast.error(t("Failed to save appointment"));
    } finally {
      setBusy(null);
    }
  }

  async function handleRestore() {
    if (!event) return;
    setBusy("restore");
    try {
      const updated = await restoreEvent(supabase, event);
      toast.success(t("Appointment restored"));
      onUpdated?.(updated);
      onClose();
    } catch (err) {
      console.error("[calendar] restore:", err);
      toast.error(t("Failed to save appointment"));
    } finally {
      setBusy(null);
    }
  }

  async function handleDelete() {
    if (!event) return;
    setBusy("delete");
    try {
      await deleteEvent(supabase, event.id);
      toast.success(t("Appointment deleted"));
      onDeleted?.(event.id);
      onClose();
    } catch (err) {
      console.error("[calendar] delete:", err);
      toast.error(t("Failed to delete appointment"));
    } finally {
      setBusy(null);
    }
  }

  async function handleRespond(response: CalendarAttendeeResponse) {
    if (!event || !me) return;
    setBusy("respond");
    try {
      const updated = await respondToEvent(supabase, event.id, me, response);
      onUpdated?.(updated);
      toast.success(response === "accepted" ? t("You accepted the appointment") : t("You declined the appointment"));
    } catch (err) {
      console.error("[calendar] respond:", err);
      toast.error(t("Failed to save response"));
    } finally {
      setBusy(null);
    }
  }

  const myAttendance = event?.attendees?.find((a) => a.user_id === me) ?? null;
  const cancelled = event?.status === "cancelled";
  const ownerMember = members.find((m) => m.user_id === owner) ?? null;
  const previewColor = color || colorForUser(owner || null);
  const canSave = !readOnly && !saving && !!title.trim() && !!range && !rangeInvalid;

  return (
    <div className="flex h-full flex-col">
      <SheetHeader className="gap-1 border-b border-border/50 p-4 pr-12">
        <div className="flex items-center gap-2">
          <span className="h-3 w-3 shrink-0 rounded-full" style={{ backgroundColor: previewColor }} aria-hidden />
          <SheetTitle className="text-popover-foreground">{isEdit ? t("Appointment") : t("New appointment")}</SheetTitle>
          {cancelled && (
            <span className="rounded-full border border-border bg-muted px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              {t("Cancelled")}
            </span>
          )}
          {isEdit && event && event.source !== "internal" && (
            <span
              className="inline-flex items-center gap-1 rounded-full border border-border bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground"
              title={event.source === "google" ? t("Synced from Google Calendar") : t("Synced from Outlook")}
            >
              <ProviderIcon provider={event.source} />
              {event.source === "google" ? t("Synced from Google Calendar") : t("Synced from Outlook")}
            </span>
          )}
          {saving && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
        </div>
        {isEdit && event && (
          <p className="text-xs text-muted-foreground">
            {formatEventRange(event, language, tz, { withDate: true, allDayLabel: t("All day") })}
          </p>
        )}
      </SheetHeader>

      <div className="flex-1 space-y-4 overflow-y-auto p-4">
        {/* My answer — only when I am an attendee of an existing event. */}
        {isEdit && myAttendance && !cancelled && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-primary/30 bg-primary/5 px-3 py-2">
            <span className="text-xs text-foreground">
              {myAttendance.response === "accepted"
                ? t("You accepted this appointment")
                : myAttendance.response === "declined"
                  ? t("You declined this appointment")
                  : t("Will you attend?")}
            </span>
            <div className="flex items-center gap-1">
              <Button
                type="button"
                size="xs"
                variant={myAttendance.response === "accepted" ? "default" : "outline"}
                disabled={busy !== null}
                onClick={() => void handleRespond("accepted")}
              >
                <Check className="h-3 w-3" />
                {t("Accept")}
              </Button>
              <Button
                type="button"
                size="xs"
                variant={myAttendance.response === "declined" ? "destructive" : "outline"}
                disabled={busy !== null}
                onClick={() => void handleRespond("declined")}
              >
                <X className="h-3 w-3" />
                {t("Decline")}
              </Button>
            </div>
          </div>
        )}

        {/* Title */}
        <div className="grid gap-1.5">
          <Label className="text-muted-foreground">{t("Title")}</Label>
          <Input
            value={title}
            disabled={readOnly}
            autoFocus={!isEdit}
            placeholder={t("What is this appointment about?")}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void handleSave();
              }
            }}
            className="border-border bg-muted text-base font-medium text-foreground md:text-sm"
          />
        </div>

        {/* When */}
        <div className="grid gap-2 rounded-lg border border-border/60 p-3">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{t("When")}</p>
            <label className="inline-flex items-center gap-2 text-xs text-foreground">
              <Checkbox
                checked={allDay}
                disabled={readOnly}
                onCheckedChange={(checked) => {
                  const next = checked === true;
                  setAllDay(next);
                  if (next) {
                    const s = fromZonedInputValue(startLocal, tz);
                    const e = fromZonedInputValue(endLocal, tz);
                    if (s) setStartDate(toZonedDateValue(s, tz));
                    if (e) setEndDate(toZonedDateValue(new Date(Math.max(new Date(e).getTime() - 1, new Date(s ?? e).getTime())).toISOString(), tz));
                  } else {
                    const s = fromZonedInputValue(startDate, tz);
                    if (s) {
                      const day = startOfDayIn(new Date(s), tz);
                      const start = new Date(day.getTime() + 9 * 3_600_000);
                      setStartLocal(toZonedInputValue(start.toISOString(), tz));
                      setEndLocal(toZonedInputValue(new Date(start.getTime() + 3_600_000).toISOString(), tz));
                      lastStart.current = toZonedInputValue(start.toISOString(), tz);
                    }
                  }
                }}
              />
              {t("All day")}
            </label>
          </div>
          {allDay ? (
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5">
                <Label className="text-muted-foreground">{t("Start")}</Label>
                <Input
                  type="date"
                  value={startDate}
                  disabled={readOnly}
                  onChange={(e) => {
                    setStartDate(e.target.value);
                    if (!endDate || e.target.value > endDate) setEndDate(e.target.value);
                  }}
                  className="border-border bg-muted text-foreground"
                />
              </div>
              <div className="grid gap-1.5">
                <Label className="text-muted-foreground">{t("End")}</Label>
                <Input
                  type="date"
                  value={endDate}
                  min={startDate}
                  disabled={readOnly}
                  onChange={(e) => setEndDate(e.target.value)}
                  className="border-border bg-muted text-foreground"
                />
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5">
                <Label className="text-muted-foreground">{t("Start")}</Label>
                <Input
                  type="datetime-local"
                  value={startLocal}
                  disabled={readOnly}
                  onChange={(e) => setStartLocal(e.target.value)}
                  className="border-border bg-muted text-foreground"
                />
              </div>
              <div className="grid gap-1.5">
                <Label className="text-muted-foreground">{t("End")}</Label>
                <Input
                  type="datetime-local"
                  value={endLocal}
                  min={startLocal}
                  disabled={readOnly}
                  onChange={(e) => setEndLocal(e.target.value)}
                  aria-invalid={rangeInvalid || undefined}
                  className="border-border bg-muted text-foreground"
                />
              </div>
            </div>
          )}
          {rangeInvalid && <p className="text-xs text-red-500">{t("The end must be after the start.")}</p>}
          {conflicts.length > 0 && (
            <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-2.5 py-2 text-xs text-amber-700 dark:text-amber-300">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <div className="min-w-0">
                <p className="font-medium">
                  {ownerMember ? `${memberName(members, owner)} ${t("already has an appointment at this time")}` : t("Schedule conflict")}
                </p>
                <ul className="mt-0.5 space-y-0.5">
                  {conflicts.slice(0, 3).map((c) => (
                    <li key={c.id} className="truncate">
                      {formatEventRange(c, language, tz, { withDate: true, allDayLabel: t("All day") })} · {c.title}
                    </li>
                  ))}
                  {conflicts.length > 3 && <li>+{conflicts.length - 3}</li>}
                </ul>
              </div>
            </div>
          )}
          <p className="text-[11px] text-muted-foreground">
            {t("Timezone")}: <span data-no-translate>{timezoneLabel(tz, language)}</span>
          </p>
        </div>

        {/* Location + description */}
        <div className="grid gap-1.5">
          <Label className="text-muted-foreground">{t("Location")}</Label>
          <div className="relative">
            <MapPin className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={location}
              disabled={readOnly}
              placeholder={t("Address, meeting room or video call link")}
              onChange={(e) => setLocation(e.target.value)}
              className="border-border bg-muted pl-8 text-foreground"
            />
          </div>
        </div>
        <div className="grid gap-1.5">
          <Label className="text-muted-foreground">{t("Description")}</Label>
          <Textarea
            value={description}
            disabled={readOnly}
            rows={3}
            placeholder={t("Agenda, context, what to prepare…")}
            onChange={(e) => setDescription(e.target.value)}
            className="min-h-20 border-border bg-muted text-foreground"
          />
        </div>

        {/* Assignee ("Responsável") + reminder */}
        <div className="grid grid-cols-2 gap-3">
          <div className="grid gap-1.5">
            <Label className="text-muted-foreground">{t("Assignee")}</Label>
            <select value={owner} disabled={readOnly} onChange={(e) => setOwner(e.target.value)} className={SELECT_CLASS}>
              <option value="">{t("No assignee")}</option>
              {members.map((m) => (
                <option key={m.user_id} value={m.user_id}>
                  {m.full_name?.trim() || m.email}
                </option>
              ))}
            </select>
          </div>
          <div className="grid gap-1.5">
            <Label className="text-muted-foreground">{t("Reminder")}</Label>
            <div className="relative">
              <Bell className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <select
                value={reminder ?? ""}
                disabled={readOnly}
                onChange={(e) => setReminder(e.target.value ? (Number(e.target.value) as ReminderMinutes) : null)}
                className={cn(SELECT_CLASS, "pl-8")}
              >
                <option value="">{t("No reminder")}</option>
                {REMINDER_OPTIONS.map((m) => (
                  <option key={m} value={m}>
                    {t(REMINDER_LABELS[m])}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>

        {/* Attendees */}
        <div className="grid gap-1.5">
          <Label className="flex items-center gap-1.5 text-muted-foreground">
            <Users className="h-3.5 w-3.5" />
            {t("Attendees")}
          </Label>
          <div className="flex flex-wrap gap-1.5">
            {members
              .filter((m) => m.user_id !== owner)
              .map((m) => {
                const on = attendees.includes(m.user_id);
                const answer = event?.attendees?.find((a) => a.user_id === m.user_id)?.response;
                return (
                  <button
                    key={m.user_id}
                    type="button"
                    disabled={readOnly}
                    aria-pressed={on}
                    onClick={() =>
                      setAttendees((prev) => (on ? prev.filter((id) => id !== m.user_id) : [...prev, m.user_id]))
                    }
                    className={cn(
                      "inline-flex items-center gap-1.5 rounded-full border px-2 py-1 text-xs transition-colors disabled:cursor-default",
                      on
                        ? "border-primary/40 bg-primary/10 text-primary"
                        : "border-border bg-muted text-muted-foreground hover:text-foreground",
                    )}
                  >
                    <span
                      className="h-2 w-2 rounded-full"
                      style={{ backgroundColor: colorForUser(m.user_id) }}
                      aria-hidden
                    />
                    {m.full_name?.trim() || m.email}
                    {on && answer && answer !== "needs_action" && (
                      <span
                        title={answer === "accepted" ? t("Accepted") : t("Declined")}
                        className={cn(
                          "inline-flex h-3.5 w-3.5 items-center justify-center rounded-full",
                          answer === "accepted" ? "bg-emerald-500/20 text-emerald-600" : "bg-red-500/20 text-red-500",
                        )}
                      >
                        {answer === "accepted" ? <Check className="h-2.5 w-2.5" /> : <X className="h-2.5 w-2.5" />}
                      </span>
                    )}
                    {on && (!answer || answer === "needs_action") && isEdit && (
                      <span className="text-[10px] text-muted-foreground">· {t("Pending")}</span>
                    )}
                  </button>
                );
              })}
            {members.filter((m) => m.user_id !== owner).length === 0 && (
              <span className="text-xs text-muted-foreground">{t("No other members in this account.")}</span>
            )}
          </div>
        </div>

        {/* Colour */}
        <div className="grid gap-1.5">
          <Label className="text-muted-foreground">{t("Color")}</Label>
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              disabled={readOnly}
              title={t("Owner's color")}
              aria-label={t("Owner's color")}
              aria-pressed={!color}
              onClick={() => setColor("")}
              className={cn(
                "flex h-6 w-6 items-center justify-center rounded-full border-2 text-[10px]",
                !color ? "border-foreground" : "border-transparent",
              )}
              style={{ backgroundColor: `${colorForUser(owner || null)}40` }}
            >
              <User className="h-3 w-3" style={{ color: colorForUser(owner || null) }} />
            </button>
            {EVENT_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                disabled={readOnly}
                aria-label={c}
                aria-pressed={color === c}
                onClick={() => setColor(c)}
                className={cn("h-6 w-6 rounded-full border-2", color === c ? "border-foreground" : "border-transparent")}
                style={{ backgroundColor: c }}
              />
            ))}
          </div>
        </div>

        {/* Links */}
        <div className="grid gap-3 rounded-lg border border-border/60 p-3">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{t("Links")}</p>

          {/* Contact */}
          <div className="grid gap-1.5">
            <Label className="text-muted-foreground">{t(EVENT_LINK_LABELS.contact)}</Label>
            <div className="flex items-center gap-2">
              <div className="min-w-0 flex-1">
                <ContactPicker
                  contact={contact}
                  disabled={readOnly}
                  onChange={(next) => {
                    setContact(next);
                    setContactId(next?.id ?? "");
                    // Conversation and deal belong to the contact — drop them on change.
                    setConversationId("");
                    setDealId("");
                  }}
                />
              </div>
              {contactId && <OpenLink href={linkHref("contact", contactId)} label={t("Open contact")} icon={User} />}
            </div>
          </div>

          {/* Conversation of the contact */}
          {contactId && (
            <div className="grid gap-1.5">
              <Label className="text-muted-foreground">{t(EVENT_LINK_LABELS.conversation)}</Label>
              <div className="flex items-center gap-2">
                <select
                  value={conversationId}
                  disabled={readOnly || (conversations.length === 0 && !conversationId)}
                  onChange={(e) => setConversationId(e.target.value)}
                  className={SELECT_CLASS}
                >
                  <option value="">{conversations.length === 0 ? t("No conversations with this contact") : t("No conversation")}</option>
                  {conversations.map((c) => (
                    <option key={c.id} value={c.id}>
                      {t("Conversation")} · {new Date(c.last_message_at ?? c.created_at).toLocaleDateString(language, { day: "2-digit", month: "short", year: "numeric" })}
                      {c.status && c.status !== "open" ? ` · ${t(c.status === "closed" ? "Closed" : "Pending")}` : ""}
                    </option>
                  ))}
                  {conversationId && !conversations.some((c) => c.id === conversationId) && (
                    <option value={conversationId}>{t("Conversation")}</option>
                  )}
                </select>
                {conversationId && (
                  <OpenLink href={linkHref("conversation", conversationId)} label={t("Open conversation")} icon={MessageSquare} />
                )}
              </div>
            </div>
          )}

          {/* Deal of the contact */}
          {contactId && modules.pipelines && (
            <div className="grid gap-1.5">
              <Label className="text-muted-foreground">{t(EVENT_LINK_LABELS.deal)}</Label>
              <div className="flex items-center gap-2">
                <select
                  value={dealId}
                  disabled={readOnly || (deals.length === 0 && !dealId)}
                  onChange={(e) => setDealId(e.target.value)}
                  className={SELECT_CLASS}
                >
                  <option value="">{deals.length === 0 ? t("No deals for this contact") : t("No deal")}</option>
                  {deals.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.title}
                      {d.status && d.status !== "open" ? ` · ${t(d.status === "won" ? "Won" : "Lost")}` : ""}
                    </option>
                  ))}
                  {dealId && !deals.some((d) => d.id === dealId) && (
                    <option value={dealId}>{event?.deal?.title ?? t("Deal")}</option>
                  )}
                </select>
                {dealId && <OpenLink href={linkHref("deal", dealId)} label={t("Open in Pipelines")} icon={GitBranch} />}
              </div>
            </div>
          )}

          {/* Task */}
          {modules.tasks && (
            <div className="grid gap-1.5">
              <Label className="text-muted-foreground">{t(EVENT_LINK_LABELS.task)}</Label>
              <div className="flex items-center gap-2">
                <div className="min-w-0 flex-1">
                  <TaskPicker
                    task={task}
                    disabled={readOnly}
                    onChange={(next) => {
                      setTask(next);
                      setTaskId(next?.id ?? "");
                    }}
                  />
                </div>
                {taskId && <OpenLink href={linkHref("task", taskId)} label={t("Open task")} icon={CheckSquare} />}
              </div>
            </div>
          )}

          {/* Internal chat thread */}
          {chatEnabled && (
            <div className="grid gap-1.5">
              <Label className="text-muted-foreground">{t(EVENT_LINK_LABELS.chat_thread)}</Label>
              <div className="flex items-center gap-2">
                <select
                  value={chatThreadId}
                  disabled={readOnly || (threads.length === 0 && !chatThreadId)}
                  onChange={(e) => setChatThreadId(e.target.value)}
                  className={SELECT_CLASS}
                >
                  <option value="">{t("No chat linked")}</option>
                  {threads.map((th) => (
                    <option key={th.id} value={th.id}>
                      {th.kind === "group"
                        ? th.title?.trim() || t("Group")
                        : memberName(members, otherMemberId(th, me ?? "")) || t("Direct chat")}
                    </option>
                  ))}
                  {chatThreadId && !threads.some((th) => th.id === chatThreadId) && (
                    <option value={chatThreadId}>{event?.chat_thread?.title ?? t("Internal chat")}</option>
                  )}
                </select>
                {chatThreadId && (
                  <OpenLink href={linkHref("chat_thread", chatThreadId)} label={t("Open chat")} icon={MessagesSquare} />
                )}
              </div>
            </div>
          )}
        </div>

        {/* Task due option (create from a task) */}
        {!isEdit && offerTaskDue && taskId && (
          <label className="flex items-center gap-2 rounded-lg border border-border/60 px-3 py-2 text-xs text-foreground">
            <Checkbox checked={setTaskDue} onCheckedChange={(c) => setSetTaskDue(c === true)} />
            {t("Also set the task's due date to the appointment start")}
          </label>
        )}

        {isEdit && event && (
          <p className="text-[11px] text-muted-foreground">
            {t("Created by")} {memberName(members, event.created_by) || "—"}
          </p>
        )}
      </div>

      {/* Footer */}
      <div className="border-t border-border/50 bg-popover/50 p-3">
        {confirmDelete ? (
          <div className="flex items-center gap-3 rounded-lg border border-red-500/30 bg-red-500/10 p-3">
            <AlertTriangle className="h-4 w-4 shrink-0 text-red-400" />
            <p className="flex-1 text-xs text-foreground">{t("Delete this appointment? This cannot be undone.")}</p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setConfirmDelete(false)}
              className="border-border text-muted-foreground hover:bg-muted"
            >
              {t("Cancel")}
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={() => void handleDelete()}
              disabled={busy === "delete"}
              className="bg-red-600 text-white hover:bg-red-700"
            >
              {busy === "delete" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : t("Delete")}
            </Button>
          </div>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-1">
              {isEdit && !readOnly && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setConfirmDelete(true)}
                  className="text-muted-foreground hover:bg-red-500/10 hover:text-red-500"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  {t("Delete")}
                </Button>
              )}
              {isEdit && !readOnly && (
                cancelled ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={busy !== null}
                    onClick={() => void handleRestore()}
                    className="text-muted-foreground hover:text-foreground"
                  >
                    {busy === "restore" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
                    {t("Restore")}
                  </Button>
                ) : (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={busy !== null}
                    onClick={() => void handleCancelEvent()}
                    className="text-muted-foreground hover:text-foreground"
                  >
                    {busy === "cancel" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Ban className="h-3.5 w-3.5" />}
                    {t("Cancel appointment")}
                  </Button>
                )
              )}
            </div>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={onClose}
                className="border-border text-muted-foreground hover:bg-muted"
              >
                {readOnly ? t("Close") : t("Cancel")}
              </Button>
              {!readOnly && (
                <Button
                  type="button"
                  onClick={() => void handleSave()}
                  disabled={!canSave}
                  className="bg-primary text-primary-foreground hover:bg-primary/90"
                >
                  {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <CalendarDays className="h-4 w-4" />}
                  {t("Save")}
                </Button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------
// Pieces
// ------------------------------------------------------------

function OpenLink({ href, label, icon: Icon }: { href: string; label: string; icon: typeof User }) {
  return (
    <Link
      href={href}
      title={label}
      aria-label={label}
      className="inline-flex h-8 shrink-0 items-center gap-1 rounded-lg border border-border px-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
    >
      <Icon className="h-3.5 w-3.5" />
      <ExternalLink className="h-3 w-3" />
    </Link>
  );
}

/** Search a task by title; shows the pick as a chip. */
function TaskPicker({
  task,
  disabled,
  onChange,
}: {
  task: CalendarTaskRef | null;
  disabled?: boolean;
  onChange: (task: CalendarTaskRef | null) => void;
}) {
  const { t } = useLanguage();
  const supabase = useMemo(() => createClient(), []);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<CalendarTaskRef[]>([]);
  const [openList, setOpenList] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    const q = query.trim();
    timer.current = setTimeout(async () => {
      if (!q) {
        setResults([]);
        return;
      }
      const like = `%${q.replace(/[%_,]/g, " ")}%`;
      const { data } = await supabase
        .from("tasks")
        .select("id, title")
        .ilike("title", like)
        .is("completed_at", null)
        .order("created_at", { ascending: false })
        .limit(8);
      setResults((data ?? []) as CalendarTaskRef[]);
    }, 200);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [query, supabase]);

  if (task) {
    return (
      <div className="flex h-8 items-center gap-2 rounded-lg border border-border bg-muted px-2.5 text-sm text-foreground">
        <CheckSquare className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate">{task.title}</span>
        {!disabled && (
          <button
            type="button"
            onClick={() => onChange(null)}
            aria-label={t("Unlink")}
            title={t("Unlink")}
            className="text-muted-foreground hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="relative">
      <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
      <Input
        value={query}
        disabled={disabled}
        placeholder={t("Search task by title")}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpenList(true);
        }}
        onFocus={() => setOpenList(true)}
        onBlur={() => setTimeout(() => setOpenList(false), 120)}
        className="border-border bg-muted pl-8 text-foreground"
      />
      {openList && results.length > 0 && (
        <ul className="absolute z-30 mt-1 max-h-56 w-full overflow-y-auto rounded-lg border border-border bg-popover p-1 shadow-lg">
          {results.map((r) => (
            <li key={r.id}>
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  onChange(r);
                  setQuery("");
                  setResults([]);
                  setOpenList(false);
                }}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-popover-foreground hover:bg-muted"
              >
                <CheckSquare className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate">{r.title}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// Re-exported for the quick-create so a "more options" hand-off can
// seed a whole day when the click landed on the month grid.
export function dayDefaults(day: Date, tz: string): { starts_at: string; ends_at: string; all_day: boolean } {
  const start = startOfDayIn(day, tz);
  return { starts_at: start.toISOString(), ends_at: addDaysIn(start, 1, tz).toISOString(), all_day: true };
}

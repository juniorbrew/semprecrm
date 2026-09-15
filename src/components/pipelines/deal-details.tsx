"use client";

import { useState } from "react";
import Link from "next/link";
import type { Conversation, Deal, DealStatus, PipelineStage } from "@/types";
import type { Task } from "@/lib/tasks";
import {
  LinkedTaskRows,
  TaskDrawer,
  TaskQuickCreate,
  useLinkedTasks,
} from "@/components/tasks";
import { LinkedEvents } from "@/components/calendar";
import { Button } from "@/components/ui/button";
import { SheetTitle } from "@/components/ui/sheet";
import { formatCurrency } from "@/lib/currency";
import { inboxConversationHref } from "@/lib/conversations/find-by-contact";
import {
  advanceToLabel,
  closeDateInfo,
  longDateTime,
  relativeTime,
  type CloseDateTone,
} from "@/lib/pipelines/deal-dates";
import { useLanguage } from "@/hooks/use-language";
import { useEntitlements } from "@/hooks/use-auth";
import { useCan } from "@/hooks/use-can";
import { cn } from "@/lib/utils";
import {
  ArrowRight,
  CalendarClock,
  Check,
  Loader2,
  MessageSquareX,
  Plus,
  MessageSquare,
  Pencil,
  Phone,
  RotateCcw,
  StickyNote,
  Trophy,
  User,
  X,
} from "lucide-react";

interface DealDetailsProps {
  deal: Deal;
  stages: PipelineStage[];
  conversation: Conversation | null;
  conversationLoading: boolean;
  busy: "won" | "lost" | "open" | "advance" | null;
  onEdit: () => void;
  onStatus: (status: DealStatus) => void;
  onAdvance: (stage: PipelineStage) => void;
}

function initials(name?: string, fallback?: string) {
  const source = (name || fallback || "?").trim();
  if (!source) return "?";
  const parts = source.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return (parts[0].charAt(0) + parts[1].charAt(0)).toUpperCase();
  }
  return source.charAt(0).toUpperCase();
}

const CLOSE_TONE_CLASS: Record<CloseDateTone, string> = {
  overdue: "text-red-500 dark:text-red-400",
  today: "text-amber-600 dark:text-amber-400",
  soon: "text-foreground",
  later: "text-muted-foreground",
};

const CONVERSATION_STATUS_KEY: Record<Conversation["status"], string> = {
  open: "Open",
  pending: "Pending",
  closed: "Closed",
};

export function DealDetails({
  deal,
  stages,
  conversation,
  conversationLoading,
  busy,
  onEdit,
  onStatus,
  onAdvance,
}: DealDetailsProps) {
  const { t, language } = useLanguage();
  // Tasks section — hidden when the plan has no Tasks module; the "+"
  // needs agent+ (tasks RLS).
  const { ready: entitlementsReady, modules } = useEntitlements();
  const tasksEnabled = !entitlementsReady || modules.tasks;
  const canWriteTasks = useCan("send-messages");
  // "Agenda" section — the deal's next appointments (calendar module).
  const calendarEnabled = !entitlementsReady || modules.calendar;
  const linkedTasks = useLinkedTasks({ dealId: deal.id, enabled: tasksEnabled });
  const [taskAddOpen, setTaskAddOpen] = useState(false);
  const [taskDrawerTask, setTaskDrawerTask] = useState<Task | null>(null);
  const [taskDrawerOpen, setTaskDrawerOpen] = useState(false);

  const sorted = [...stages].sort((a, b) => a.position - b.position);
  const stageIndex = sorted.findIndex((s) => s.id === deal.stage_id);
  const stage = stageIndex >= 0 ? sorted[stageIndex] : null;
  const nextStage =
    stageIndex >= 0 && stageIndex < sorted.length - 1
      ? sorted[stageIndex + 1]
      : null;

  const status: DealStatus = deal.status ?? "open";
  const isOpen = status === "open";
  const close = deal.expected_close_date
    ? closeDateInfo(deal.expected_close_date, language)
    : null;

  const contact = deal.contact ?? null;
  const contactName = contact?.name || contact?.phone || t("No contact");
  const ownerName = deal.assignee?.full_name || deal.assignee?.email || null;

  const conversationHref = conversation
    ? inboxConversationHref(conversation.id)
    : null;

  // Timeline — the schema stores no per-stage history, so the events
  // are the ones we can vouch for: creation, expected close, the last
  // update, and the won/lost outcome (stamped by `updated_at`).
  const timeline: {
    key: string;
    label: string;
    at: string | null;
    tone?: "won" | "lost" | "muted";
    detail?: string;
  }[] = [];
  timeline.push({
    key: "created",
    label: t("Deal created"),
    at: deal.created_at,
  });
  if (deal.updated_at && deal.updated_at !== deal.created_at && isOpen) {
    timeline.push({
      key: "updated",
      label: t("Last update"),
      at: deal.updated_at,
      detail: stage ? `${t("Stage")}: ${stage.name}` : undefined,
    });
  }
  if (close) {
    timeline.push({
      key: "close",
      label: t("Expected close"),
      at: null,
      detail: close.long,
      tone: "muted",
    });
  }
  const lossReasonName =
    status === "lost" ? deal.loss_reason?.name ?? null : null;
  const lostNote = status === "lost" ? deal.lost_note?.trim() || null : null;
  if (!isOpen) {
    timeline.push({
      key: status,
      label: status === "won" ? t("Marked as won") : t("Marked as lost"),
      at: deal.updated_at ?? null,
      tone: status,
      detail:
        status === "lost"
          ? `${t("Loss reason")}: ${lossReasonName ?? t("No reason")}`
          : undefined,
    });
  }

  return (
    <div className="flex h-full flex-col">
      {/* Header: chips, title, value, primary actions */}
      <div className="border-b border-border/50 p-4 pr-12">
        <div className="flex flex-wrap items-center gap-1.5">
          {stage && (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/60 px-2 py-0.5 text-[11px] font-medium text-foreground">
              <span
                aria-hidden
                className="h-2 w-2 rounded-full"
                style={{ backgroundColor: stage.color }}
              />
              {stage.name}
            </span>
          )}
          {status === "won" && (
            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[11px] font-semibold text-emerald-600 dark:text-emerald-400">
              <Trophy className="h-3 w-3" />
              {t("Won")}
            </span>
          )}
          {status === "lost" && (
            <span className="inline-flex items-center gap-1 rounded-full bg-red-500/15 px-2 py-0.5 text-[11px] font-semibold text-red-600 dark:text-red-400">
              <X className="h-3 w-3" />
              {t("Lost")}
              {lossReasonName && (
                <>
                  <span className="opacity-60">·</span>
                  <span className="max-w-[160px] truncate font-medium">{lossReasonName}</span>
                </>
              )}
            </span>
          )}
          {isOpen && (
            <span className="inline-flex items-center rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-semibold text-primary">
              {t("Open deal")}
            </span>
          )}
          <Button
            type="button"
            size="xs"
            variant="ghost"
            onClick={onEdit}
            disabled={!!busy}
            className="ml-auto text-muted-foreground hover:text-foreground"
          >
            <Pencil />
            {t("Edit")}
          </Button>
        </div>

        <SheetTitle className="mt-2 text-lg font-semibold leading-snug text-popover-foreground break-words">
          {deal.title}
        </SheetTitle>

        <div className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="text-2xl font-bold tracking-tight text-primary">
            {formatCurrency(deal.value, deal.currency)}
          </span>
          {close && (
            <span
              className={cn(
                "inline-flex items-center gap-1 text-xs font-medium",
                CLOSE_TONE_CLASS[close.tone],
              )}
              title={close.long}
            >
              <CalendarClock className="h-3.5 w-3.5" />
              {close.tone === "later"
                ? `${t("Closes")} ${close.short}`
                : close.short}
            </span>
          )}
        </div>

        {/* Stage progress: one segment per stage, filled up to the
            current one, so "where is this deal in the funnel" reads at
            a glance without opening a select. */}
        {sorted.length > 1 && (
          <div className="mt-3" aria-hidden>
            <div className="flex gap-1">
              {sorted.map((s, i) => (
                <span
                  key={s.id}
                  title={s.name}
                  className={cn(
                    "h-1.5 flex-1 rounded-full transition-colors",
                    i <= stageIndex ? "" : "bg-muted",
                  )}
                  style={
                    i <= stageIndex
                      ? {
                          backgroundColor:
                            status === "lost" ? "#ef4444" : (stage?.color ?? s.color),
                          opacity: i === stageIndex ? 1 : 0.45,
                        }
                      : undefined
                  }
                />
              ))}
            </div>
            <p className="mt-1 text-[11px] text-muted-foreground">
              {t("Stage")} {stageIndex + 1}/{sorted.length}
              {nextStage ? (
                <>
                  <span className="mx-1">·</span>
                  {t("Next stage")}: {nextStage.name}
                </>
              ) : (
                <>
                  <span className="mx-1">·</span>
                  {t("Last stage")}
                </>
              )}
            </p>
          </div>
        )}

        <div className="mt-3 flex flex-wrap items-center gap-2">
          {isOpen ? (
            <>
              <Button
                type="button"
                size="sm"
                onClick={() => onStatus("won")}
                disabled={!!busy}
                className="bg-emerald-600 text-white hover:bg-emerald-700"
              >
                {busy === "won" ? (
                  <Loader2 className="animate-spin" />
                ) : (
                  <Check />
                )}
                {t("Won")}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => onStatus("lost")}
                disabled={!!busy}
                className="border-red-500/40 text-red-600 hover:bg-red-500/10 hover:text-red-600 dark:text-red-400 dark:hover:text-red-400"
              >
                {busy === "lost" ? (
                  <Loader2 className="animate-spin" />
                ) : (
                  <X />
                )}
                {t("Lost")}
              </Button>
              {nextStage && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => onAdvance(nextStage)}
                  disabled={!!busy}
                  className="border-border bg-card text-foreground hover:bg-muted"
                  title={advanceToLabel(nextStage.name, language)}
                >
                  {busy === "advance" ? (
                    <Loader2 className="animate-spin" />
                  ) : (
                    <ArrowRight />
                  )}
                  <span className="max-w-[220px] truncate">
                    {advanceToLabel(nextStage.name, language)}
                  </span>
                </Button>
              )}
            </>
          ) : (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => onStatus("open")}
              disabled={!!busy}
              className="border-border bg-card text-foreground hover:bg-muted"
            >
              {busy === "open" ? (
                <Loader2 className="animate-spin" />
              ) : (
                <RotateCcw />
              )}
              {t("Reopen deal")}
            </Button>
          )}
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 space-y-5 overflow-y-auto p-4">
        {/* Loss reason — only while the deal is lost; reopening clears it. */}
        {status === "lost" && (
          <section>
            <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              {t("Loss reason")}
            </h3>
            <div className="flex gap-2 rounded-xl border border-red-500/30 bg-red-500/5 p-3">
              <MessageSquareX className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-500" />
              <div className="min-w-0 flex-1">
                <p
                  className={cn(
                    "text-sm font-medium",
                    lossReasonName ? "text-foreground" : "text-muted-foreground",
                  )}
                >
                  {lossReasonName ?? t("No reason")}
                </p>
                {lostNote && (
                  <p className="mt-1 whitespace-pre-wrap text-xs leading-relaxed text-muted-foreground">
                    {lostNote}
                  </p>
                )}
              </div>
            </div>
          </section>
        )}

        {/* Contact */}
        <section>
          <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            {t("Contact")}
          </h3>
          <div className="rounded-xl border border-border bg-card p-3">
            <div className="flex items-start gap-3">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/15 text-sm font-semibold text-primary">
                {initials(contact?.name, contact?.phone)}
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold text-foreground">
                  {contactName}
                </p>
                {contact?.phone && (
                  <a
                    href={`tel:${contact.phone.replace(/[^+\d]/g, "")}`}
                    className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                  >
                    <Phone className="h-3 w-3" />
                    <span className="truncate">{contact.phone}</span>
                  </a>
                )}
                {contact?.company && (
                  <p className="mt-0.5 truncate text-xs text-muted-foreground">
                    {contact.company}
                  </p>
                )}
              </div>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {conversationHref ? (
                <Button
                  size="sm"
                  className="bg-primary text-primary-foreground hover:bg-primary/90"
                  nativeButton={false}
                  render={<Link href={conversationHref} />}
                >
                  <MessageSquare />
                  {t("Open conversation")}
                </Button>
              ) : (
                <span className="text-xs text-muted-foreground">
                  {conversationLoading
                    ? t("Loading...")
                    : contact
                      ? t("No conversation with this contact yet")
                      : t("No contact linked to this deal")}
                </span>
              )}
            </div>
          </div>
        </section>

        {/* Conversation preview */}
        {conversation && (
          <section>
            <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              {t("Conversation")}
            </h3>
            <Link
              href={conversationHref ?? "/inbox"}
              className="block rounded-xl border border-border bg-card p-3 transition-colors hover:border-primary/40 hover:bg-muted/60"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
                  <span
                    aria-hidden
                    className={cn(
                      "h-1.5 w-1.5 rounded-full",
                      conversation.status === "open"
                        ? "bg-emerald-500"
                        : conversation.status === "pending"
                          ? "bg-amber-500"
                          : "bg-muted-foreground/60",
                    )}
                  />
                  {t(CONVERSATION_STATUS_KEY[conversation.status])}
                  {conversation.unread_count > 0 && (
                    <span className="ml-1 rounded-full bg-primary px-1.5 py-px text-[10px] font-semibold text-primary-foreground">
                      {conversation.unread_count}
                    </span>
                  )}
                </span>
                {conversation.last_message_at && (
                  <span
                    className="shrink-0 text-[11px] text-muted-foreground"
                    title={longDateTime(conversation.last_message_at, language)}
                  >
                    {relativeTime(conversation.last_message_at, language)}
                  </span>
                )}
              </div>
              <p className="mt-1.5 line-clamp-2 text-sm text-foreground">
                {conversation.last_message_text || (
                  <span className="text-muted-foreground">
                    {t("No messages yet")}
                  </span>
                )}
              </p>
            </Link>
          </section>
        )}

        {/* Owner */}
        <section>
          <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            {t("Owner")}
          </h3>
          <div className="flex items-center gap-2.5">
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-muted text-[11px] font-semibold text-foreground">
              {ownerName ? initials(ownerName) : <User className="h-3.5 w-3.5" />}
            </span>
            <span
              className={cn(
                "text-sm",
                ownerName ? "text-foreground" : "text-muted-foreground",
              )}
            >
              {ownerName ?? t("Unassigned")}
            </span>
          </div>
        </section>

        {/* Tasks — open tasks of this deal; checkbox completes, "+"
            reveals the inline creator prefilled with deal + contact. */}
        {tasksEnabled && (
          <section>
            <div className="mb-2 flex items-center justify-between gap-2">
              <h3 className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                {t("Tasks")}
                {linkedTasks.tasks.length > 0 && (
                  <span className="rounded-full bg-muted px-1.5 text-[10px] font-semibold tabular-nums">
                    {linkedTasks.tasks.length}
                  </span>
                )}
              </h3>
              {canWriteTasks && (
                <button
                  type="button"
                  aria-label={t("Add task")}
                  title={t("Add task")}
                  onClick={() => setTaskAddOpen((open) => !open)}
                  className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                  <Plus className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
            <div className="space-y-2">
              {taskAddOpen && (
                <TaskQuickCreate
                  defaults={{
                    deal_id: deal.id,
                    contact_id: deal.contact_id ?? undefined,
                  }}
                  statuses={linkedTasks.statuses}
                  onCreated={linkedTasks.add}
                  onCancel={() => setTaskAddOpen(false)}
                />
              )}
              <LinkedTaskRows
                tasks={linkedTasks.tasks}
                readOnly={!canWriteTasks}
                emptyLabel={linkedTasks.loading ? t("Loading...") : t("No open tasks")}
                onComplete={(task) => void linkedTasks.complete(task)}
                onOpen={(task) => {
                  setTaskDrawerTask(task);
                  setTaskDrawerOpen(true);
                }}
              />
            </div>
            <TaskDrawer
              open={taskDrawerOpen}
              onOpenChange={setTaskDrawerOpen}
              task={taskDrawerTask}
              statuses={linkedTasks.statuses}
              onUpdated={linkedTasks.patch}
              onDeleted={linkedTasks.remove}
            />
          </section>
        )}

        {/* Agenda — the deal's next appointments; "+" reveals the inline
            creator prefilled with deal + contact. */}
        {calendarEnabled && (
          <section>
            <LinkedEvents
              dealId={deal.id}
              defaults={{ contact_id: deal.contact_id ?? undefined }}
              readOnly={!canWriteTasks}
            />
          </section>
        )}

        {/* Notes */}
        <section>
          <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            {t("Notes")}
          </h3>
          {deal.notes ? (
            <div className="flex gap-2 rounded-xl border border-border bg-card p-3">
              <StickyNote className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">
                {deal.notes}
              </p>
            </div>
          ) : (
            <button
              type="button"
              onClick={onEdit}
              className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            >
              {t("Add a note")}
            </button>
          )}
        </section>

        {/* Timeline */}
        <section>
          <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            {t("Timeline")}
          </h3>
          <ol className="relative ml-1.5 space-y-3 border-l border-border pl-4">
            {timeline.map((ev) => (
              <li key={ev.key} className="relative">
                <span
                  aria-hidden
                  className={cn(
                    "absolute -left-[21px] top-1.5 h-2.5 w-2.5 rounded-full border-2 border-popover",
                    ev.tone === "won"
                      ? "bg-emerald-500"
                      : ev.tone === "lost"
                        ? "bg-red-500"
                        : ev.tone === "muted"
                          ? "bg-muted-foreground/50"
                          : "bg-primary",
                  )}
                />
                <p className="text-sm font-medium text-foreground">{ev.label}</p>
                {ev.at && (
                  <p className="text-xs text-muted-foreground">
                    {longDateTime(ev.at, language)}
                    <span className="mx-1">·</span>
                    {relativeTime(ev.at, language)}
                  </p>
                )}
                {ev.detail && (
                  <p className="text-xs text-muted-foreground">{ev.detail}</p>
                )}
              </li>
            ))}
          </ol>
        </section>
      </div>
    </div>
  );
}

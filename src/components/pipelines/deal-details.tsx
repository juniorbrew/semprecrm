"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import type { Conversation, Deal, DealStatus, PipelineStage } from "@/types";
import type { Task } from "@/lib/tasks";
import {
  DueChip,
  LinkedTaskRows,
  TaskDrawer,
  TaskQuickCreate,
  useLinkedTasks,
} from "@/components/tasks";
import { LinkedEvents } from "@/components/calendar";
import { Button } from "@/components/ui/button";
import { SheetTitle } from "@/components/ui/sheet";
import { formatCurrency, formatMoney } from "@/lib/currency";
import { inboxConversationHref } from "@/lib/conversations/find-by-contact";
import {
  advanceToLabel,
  closeDateInfo,
  lastContact,
  longDateTime,
  relativeTime,
  type CloseDateTone,
} from "@/lib/pipelines/deal-dates";
import { useLanguage } from "@/hooks/use-language";
import type { Language } from "@/lib/i18n";
import { NOTES_LABEL } from "@/components/contacts/notes-label";
import { useEntitlements } from "@/hooks/use-auth";
import { useCan } from "@/hooks/use-can";
import { cn } from "@/lib/utils";
import { createClient } from "@/lib/supabase/client";
import {
  companyErrorMessage,
  setDealCompany,
  type CompanySummary,
} from "@/lib/companies";
import { DealCompanyField } from "@/components/companies/deal-company-field";
import { DealItemsSection } from "./deal-items";
import { toast } from "sonner";
import {
  ArrowRight,
  CalendarClock,
  CircleArrowRight,
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
import { formatPhoneDisplay } from "@/lib/whatsapp/phone-utils";

interface DealDetailsProps {
  deal: Deal;
  stages: PipelineStage[];
  conversation: Conversation | null;
  conversationLoading: boolean;
  busy: "won" | "lost" | "open" | "advance" | null;
  onEdit: () => void;
  onStatus: (status: DealStatus) => void;
  onAdvance: (stage: PipelineStage) => void;
  /** The deal's company changed here (the board refetches). */
  onCompanyChanged?: () => void | Promise<void>;
  /** The product/service lines changed here (the deal value is recomputed by the database; the board refetches). */
  onItemsChanged?: () => void | Promise<void>;
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

/**
 * Conversation status chip. Language-keyed (not `t()`) because the pt-BR
 * forms are feminine — "Aberta", "Resolvida" (a *conversa*) — and the
 * catalogue's `Open`/`Closed` keys are the masculine deal/generic ones.
 * Must match the inbox list and thread header.
 */
const CONVERSATION_STATUS_LABEL: Record<
  Language,
  Record<Conversation["status"], string>
> = {
  "pt-BR": { open: "Aberta", pending: "Pendente", closed: "Resolvida" },
  "en-US": { open: "Open", pending: "Pending", closed: "Resolved" },
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
  onCompanyChanged,
  onItemsChanged,
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
  const tasksSectionRef = useRef<HTMLElement>(null);
  // Company (migration 054) — changed / removed in place, agent+.
  const [company, setCompany] = useState<CompanySummary | null>(
    deal.company ?? null,
  );
  const [savingCompany, setSavingCompany] = useState(false);
  // Product lines (migration 104): with lines, the value is their sum.
  const [itemCount, setItemCount] = useState(0);

  async function changeCompany(next: CompanySummary | null) {
    const previous = company;
    setCompany(next);
    setSavingCompany(true);
    try {
      await setDealCompany(createClient(), deal.id, next?.id ?? null);
      toast.success(next ? t("Company updated") : t("Company removed"));
      await onCompanyChanged?.();
    } catch (err) {
      setCompany(previous);
      toast.error(t(companyErrorMessage(err)));
    } finally {
      setSavingCompany(false);
    }
  }

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
  // "Before you talk": where it stopped + the next step, from what the
  // drawer already loads (no AI, no extra query). Linked tasks are open
  // tasks sorted by due date, so the first one is the next step.
  const last = lastContact(conversation, language);
  const nextTask = linkedTasks.tasks[0] ?? null;

  function openTask(task: Task) {
    setTaskDrawerTask(task);
    setTaskDrawerOpen(true);
  }

  function addNextStep() {
    setTaskAddOpen(true);
    tasksSectionRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

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
            {itemCount > 0
              ? formatMoney(deal.value, deal.currency)
              : formatCurrency(deal.value, deal.currency)}
          </span>
          {itemCount > 0 && (
            <span className="text-xs text-muted-foreground">
              {t("calculated from the items")}
            </span>
          )}
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

        {/* Before you talk — where it stopped and the next step */}
        <section>
          <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            {t("Before you talk")}
          </h3>
          <div className="divide-y divide-border/60 overflow-hidden rounded-xl border border-border bg-card">
            {conversation ? (
              <Link
                href={conversationHref ?? "/inbox"}
                className="flex gap-2.5 p-3 transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              >
                <MessageSquare className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-start justify-between gap-2">
                    {last ? (
                      <p
                        className="text-sm font-medium text-foreground"
                        title={longDateTime(last.at, language)}
                        data-no-translate
                      >
                        {last.label}
                      </p>
                    ) : (
                      <p className="text-sm text-muted-foreground">{t("No messages yet")}</p>
                    )}
                    <span className="inline-flex shrink-0 items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
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
                      <span data-no-translate>
                        {CONVERSATION_STATUS_LABEL[language][conversation.status]}
                      </span>
                      {conversation.unread_count > 0 && (
                        <span className="rounded-full bg-primary px-1.5 py-px text-[10px] font-semibold text-primary-foreground">
                          {conversation.unread_count}
                        </span>
                      )}
                    </span>
                  </div>
                  {last?.quietLabel && (
                    <p
                      className={cn(
                        "text-xs",
                        last.quiet
                          ? "font-medium text-amber-600 dark:text-amber-400"
                          : "text-muted-foreground",
                      )}
                      data-no-translate
                    >
                      {last.quietLabel}
                    </p>
                  )}
                  {conversation.last_message_text && (
                    <p className="mt-1.5 line-clamp-2 text-sm text-muted-foreground" data-no-translate>
                      {conversation.last_message_text}
                    </p>
                  )}
                </div>
              </Link>
            ) : (
              <p className="flex gap-2.5 p-3 text-xs text-muted-foreground">
                <MessageSquare className="h-3.5 w-3.5 shrink-0" />
                {conversationLoading
                  ? t("Loading...")
                  : contact
                    ? t("No conversation with this contact yet")
                    : t("No contact linked to this deal")}
              </p>
            )}
            {tasksEnabled && isOpen && (
              <div className="flex items-start gap-2.5 p-3">
                <CircleArrowRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <p className="text-[11px] font-medium text-muted-foreground">
                    {t("Next step")}
                  </p>
                  {linkedTasks.loading ? (
                    <p className="text-sm text-muted-foreground">{t("Loading...")}</p>
                  ) : nextTask ? (
                    <div className="flex flex-wrap items-center gap-x-1">
                      <button
                        type="button"
                        onClick={() => openTask(nextTask)}
                        className="min-w-0 rounded-sm text-left text-sm font-medium text-foreground underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        data-no-translate
                      >
                        {nextTask.title}
                      </button>
                      <DueChip dueAt={nextTask.due_at} />
                    </div>
                  ) : (
                    <p className="text-sm font-medium text-amber-600 dark:text-amber-400">
                      {t("No next step set")}
                    </p>
                  )}
                </div>
                {!linkedTasks.loading && !nextTask && canWriteTasks && (
                  <Button
                    type="button"
                    size="xs"
                    variant="outline"
                    onClick={addNextStep}
                    className="shrink-0 border-border bg-card text-foreground hover:bg-muted"
                  >
                    <Plus />
                    {t("Set next step")}
                  </Button>
                )}
              </div>
            )}
          </div>
        </section>

        {/* Products and services — the value of the deal is their sum */}
        <DealItemsSection
          dealId={deal.id}
          currency={deal.currency || "BRL"}
          onChanged={() => onItemsChanged?.()}
          onCount={setItemCount}
        />

        {/* Contact */}
        <section>
          <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            {t("Contact")}
          </h3>
          <div className="rounded-xl border border-border bg-card p-3">
            <div className="flex items-start gap-3">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/15 text-sm font-semibold text-primary">
                {initials(contact?.name, contact?.phone ?? undefined)}
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
                    <span className="truncate">{formatPhoneDisplay(contact.phone)}</span>
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

        {/* Company (migration 054) */}
        <section>
          <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            {t("Company")}
          </h3>
          <DealCompanyField
            company={company}
            onChange={(next) => void changeCompany(next)}
            readOnly={!canWriteTasks}
            busy={savingCompany}
            linkToCompany
          />
        </section>

        {/* Assignee — the person handling the deal ("Responsável"). Not
            the catalogue's `Owner`, which is the account role. */}
        <section>
          <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            {t("Assignee")}
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
              {ownerName ?? t("No assignee")}
            </span>
          </div>
        </section>

        {/* Tasks — open tasks of this deal; checkbox completes, "+"
            reveals the inline creator prefilled with deal + contact. */}
        {tasksEnabled && (
          <section ref={tasksSectionRef} className="scroll-mt-4">
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
                onOpen={openTask}
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
            <span data-no-translate>{NOTES_LABEL[language]}</span>
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

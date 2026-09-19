"use client";

import Link from "next/link";
import { ArrowUp, CalendarClock, ChevronsUp, Minus, ArrowDown, GitBranch, MessageSquare, User } from "lucide-react";

import { useLanguage } from "@/hooks/use-language";
import type { Language } from "@/lib/i18n";
import { inboxConversationHref } from "@/lib/conversations/find-by-contact";
import {
  dueInfo,
  type DueTone,
  type Task,
  type TaskMember,
  type TaskPriority,
  type TaskStatus,
} from "@/lib/tasks";
import { cn } from "@/lib/utils";

// ------------------------------------------------------------
// Status name
// ------------------------------------------------------------

/**
 * The default statuses are seeded in pt-BR ("A fazer", "Em andamento",
 * "Concluída" — see DEFAULT_TASK_STATUS_SEED). Their English names for
 * en-US; any custom status shows as typed. Feminine "Concluída" (a
 * *tarefa*) has no catalogue entry (`Done` is the generic "Concluído"),
 * hence this map instead of the DOM translator.
 */
const SEED_STATUS_NAME_EN: Record<string, string> = {
  "A fazer": "To do",
  "Em andamento": "In progress",
  "Concluída": "Done",
};

export function statusName(
  status: Pick<TaskStatus, "name">,
  language: Language,
): string {
  if (language === "pt-BR") return status.name;
  return SEED_STATUS_NAME_EN[status.name] ?? status.name;
}

// ------------------------------------------------------------
// Priority
// ------------------------------------------------------------

/** English keys — run through `t()`. */
export const PRIORITY_LABELS: Record<TaskPriority, string> = {
  low: "Low",
  normal: "Normal",
  high: "High",
  urgent: "Urgent",
};

const PRIORITY_CLASS: Record<TaskPriority, string> = {
  low: "bg-muted text-muted-foreground",
  normal: "bg-muted text-foreground",
  high: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  urgent: "bg-red-500/15 text-red-600 dark:text-red-400",
};

const PRIORITY_ICON: Record<TaskPriority, typeof ArrowUp> = {
  low: ArrowDown,
  normal: Minus,
  high: ArrowUp,
  urgent: ChevronsUp,
};

export function PriorityChip({
  priority,
  className,
  compact,
}: {
  priority: TaskPriority;
  className?: string;
  /** Icon only (board cards). */
  compact?: boolean;
}) {
  const { t } = useLanguage();
  const Icon = PRIORITY_ICON[priority];
  const label = t(PRIORITY_LABELS[priority]);
  if (compact && priority === "normal") return null;
  return (
    <span
      title={label}
      aria-label={label}
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium",
        PRIORITY_CLASS[priority],
        className,
      )}
    >
      <Icon className="h-3 w-3" />
      {!compact && label}
    </span>
  );
}

// ------------------------------------------------------------
// Status
// ------------------------------------------------------------

export function StatusChip({
  status,
  className,
}: {
  status: TaskStatus | null | undefined;
  className?: string;
}) {
  const { language } = useLanguage();
  if (!status) return null;
  return (
    <span
      data-no-translate
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-md bg-muted px-1.5 py-0.5 text-[11px] font-medium text-foreground",
        className,
      )}
    >
      <span
        aria-hidden
        className="h-2 w-2 rounded-full"
        style={{ backgroundColor: status.color }}
      />
      {statusName(status, language)}
    </span>
  );
}

// ------------------------------------------------------------
// Due
// ------------------------------------------------------------

const DUE_TONE_CLASS: Record<DueTone, string> = {
  overdue: "bg-red-500/10 text-red-600 dark:text-red-400 font-semibold",
  today: "bg-amber-500/15 text-amber-700 dark:text-amber-400 font-semibold",
  soon: "bg-muted text-foreground",
  later: "text-muted-foreground",
};

export function DueChip({
  dueAt,
  done,
  className,
}: {
  dueAt: string | null;
  /** Finished tasks show the date quietly, without urgency colours. */
  done?: boolean;
  className?: string;
}) {
  const { language } = useLanguage();
  const info = dueInfo(dueAt, language);
  if (!info) return null;
  return (
    <span
      title={info.long}
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px]",
        done ? "text-muted-foreground line-through" : DUE_TONE_CLASS[info.tone],
        className,
      )}
    >
      <CalendarClock className="h-3 w-3" />
      {info.short}
    </span>
  );
}

// ------------------------------------------------------------
// Assignee
// ------------------------------------------------------------

export function memberLabel(member: TaskMember | null | undefined): string {
  if (!member) return "";
  return member.full_name?.trim() || member.email;
}

function initials(text: string): string {
  const parts = text.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return parts[0].charAt(0).toUpperCase();
}

export function AssigneeAvatar({
  member,
  className,
  showName,
}: {
  member: TaskMember | null | undefined;
  className?: string;
  showName?: boolean;
}) {
  const { t } = useLanguage();
  if (!member) {
    return showName ? (
      <span className={cn("inline-flex items-center gap-1.5 text-xs text-muted-foreground", className)}>
        <User className="h-3.5 w-3.5" />
        {t("No assignee")}
      </span>
    ) : null;
  }
  const label = memberLabel(member);
  return (
    <span
      title={label}
      className={cn("inline-flex min-w-0 items-center gap-1.5 text-xs text-foreground", className)}
    >
      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/15 text-[10px] font-semibold text-primary">
        {initials(label)}
      </span>
      {showName && <span className="truncate">{label}</span>}
    </span>
  );
}

// ------------------------------------------------------------
// Link (contact / conversation / deal)
// ------------------------------------------------------------

/**
 * The task's link to the rest of the CRM: the deal when there is
 * one, otherwise the contact (both jump to their home screen).
 */
export function TaskLinkChip({ task, className }: { task: Task; className?: string }) {
  const { t } = useLanguage();
  const stop = (e: React.MouseEvent) => e.stopPropagation();

  if (task.deal) {
    return (
      <Link
        href="/pipelines"
        onClick={stop}
        title={t("Open in Pipelines")}
        className={cn(
          "inline-flex min-w-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground",
          className,
        )}
      >
        <GitBranch className="h-3 w-3 shrink-0" />
        <span className="truncate">{task.deal.title}</span>
      </Link>
    );
  }
  if (task.contact) {
    const label = task.contact.name || task.contact.phone;
    const href = task.conversation_id
      ? inboxConversationHref(task.conversation_id)
      : "/contacts";
    return (
      <Link
        href={href}
        onClick={stop}
        title={task.conversation_id ? t("Open conversation") : t("Open contact")}
        className={cn(
          "inline-flex min-w-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground",
          className,
        )}
      >
        {task.conversation_id ? (
          <MessageSquare className="h-3 w-3 shrink-0" />
        ) : (
          <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-muted text-[9px] font-semibold text-foreground">
            {initials(label)}
          </span>
        )}
        <span className="truncate">{label}</span>
      </Link>
    );
  }
  return null;
}

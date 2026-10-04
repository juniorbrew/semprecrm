"use client";

import {
  Ban,
  BellRing,
  Bot,
  CheckCheck,
  RotateCcw,
  Tag as TagIcon,
  UserMinus,
  UserPlus,
  Clock,
  DollarSign,
  Flag,
  Hourglass,
  Send,
  Star,
  Timer,
  Users,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { Language } from "@/lib/i18n";
import {
  formatConversationEvent,
  formatEventAge,
  type ConversationEvent,
} from "@/lib/conversations/events";

interface SystemEventPillProps {
  event: ConversationEvent;
  language: Language;
  /** Clock reference so a list of pills shares one "now". */
  now: number;
}

function EventIcon({ event }: { event: ConversationEvent }) {
  const cls = "size-3 shrink-0";
  switch (event.type) {
    case "assigned":
      return <UserPlus className={cls} />;
    case "unassigned":
      return <UserMinus className={cls} />;
    case "status_changed":
      if (event.status === "closed") return <CheckCheck className={cls} />;
      if (event.status === "pending") return <Clock className={cls} />;
      return <RotateCcw className={cls} />;
    case "label_added":
    case "label_removed":
    case "category_changed":
      return <TagIcon className={cls} />;
    case "priority_changed":
      return <Flag className={cls} />;
    case "resolution_set":
      return <CheckCheck className={cls} />;
    case "deal_stage_changed":
      return <DollarSign className={cls} />;
    case "sla_warning":
      return <Timer className={cls} />;
    case "sla_breached":
      return <Timer className={cn(cls, "text-red-500")} />;
    case "team_changed":
      return <Users className={cls} />;
    case "csat_sent":
      return <Send className={cls} />;
    case "csat_answered":
      return <Star className={cls} />;
    case "snoozed":
    case "unsnoozed":
      return <Hourglass className={cls} />;
    case "contact_opted_out":
      return <Ban className={cn(cls, "text-red-500")} />;
    case "contact_opted_in":
      return <BellRing className={cn(cls, "text-emerald-500")} />;
    case "ai_handoff":
    case "ai_paused":
    case "ai_resumed":
      return <Bot className={cls} />;
    default:
      return null;
  }
}

/**
 * Centred muted line for a system event in the thread stream — the
 * "who did what" layer between customer and agent bubbles, framed by a
 * hairline rule on each side ("— Atribuída a Bia —"). Copy is
 * language-keyed in the events lib (names are interpolated), so the
 * DOM translator is told to leave it alone.
 */
export function SystemEventPill({ event, language, now }: SystemEventPillProps) {
  const text = formatConversationEvent(event, language);
  if (!text) return null;
  const age = formatEventAge(event.created_at, language, now);
  return (
    <div className="flex items-center justify-center gap-2 py-0.5" data-no-translate data-testid="system-event">
      <span className="h-px w-7 shrink-0 bg-border" aria-hidden />
      <span
        title={new Date(event.created_at).toLocaleString(language)}
        className="inline-flex min-w-0 max-w-[80%] items-center gap-1.5 text-[11px] leading-4 text-muted-foreground"
      >
        <EventIcon event={event} />
        <span className={cn(event.reason ? "line-clamp-3 break-words" : "truncate")}>{text}</span>
        {age && <span className="shrink-0">· {age}</span>}
      </span>
      <span className="h-px w-7 shrink-0 bg-border" aria-hidden />
    </div>
  );
}

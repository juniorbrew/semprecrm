"use client";

import {
  Ban,
  BellRing,
  CheckCheck,
  RotateCcw,
  Tag as TagIcon,
  UserMinus,
  UserPlus,
  Clock,
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
  const cls = "h-3 w-3 shrink-0";
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
      return <TagIcon className={cls} />;
    case "contact_opted_out":
      return <Ban className={cn(cls, "text-red-500")} />;
    case "contact_opted_in":
      return <BellRing className={cn(cls, "text-emerald-500")} />;
    default:
      return null;
  }
}

/**
 * Centred grey pill for a system event in the thread stream — the
 * "who did what" layer between customer and agent bubbles. Copy is
 * language-keyed in the events lib (names are interpolated), so the
 * DOM translator is told to leave it alone.
 */
export function SystemEventPill({ event, language, now }: SystemEventPillProps) {
  const text = formatConversationEvent(event, language);
  if (!text) return null;
  const age = formatEventAge(event.created_at, language, now);
  return (
    <div className="flex justify-center py-0.5" data-no-translate>
      <span
        title={new Date(event.created_at).toLocaleString(language)}
        className={cn(
          // Solid muted pill (not a translucent tint) so it reads as a
          // chip against the doodle background, like the date divider.
          "inline-flex max-w-[85%] items-center gap-1.5 rounded-full border border-border bg-muted px-3 py-1 text-xs leading-4 text-muted-foreground",
        )}
      >
        <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-background/60 text-foreground/70">
          <EventIcon event={event} />
        </span>
        <span className="truncate font-medium text-foreground/80">{text}</span>
        {age && (
          <span className="shrink-0 text-muted-foreground/80">· {age}</span>
        )}
      </span>
    </div>
  );
}

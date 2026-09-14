"use client";

import { Check, CheckCheck } from "lucide-react";

import { cn } from "@/lib/utils";
import { useLanguage } from "@/hooks/use-language";
import { CHAT_STATUS_LABELS, messageStatus } from "@/lib/chat";
import type { ChatMessage, ChatMessageStatus } from "@/types";

/** ✓ grey = sent, ✓✓ grey = delivered, ✓✓ blue = read (spec). */
export function ChatStatusIcon({ status }: { status: ChatMessageStatus }) {
  const { t } = useLanguage();
  const label = t(CHAT_STATUS_LABELS[status]);
  if (status === "sent") {
    return <Check className="size-3.5 text-current opacity-70" aria-label={label} />;
  }
  return (
    <CheckCheck
      className={cn("size-3.5", status === "read" ? "text-sky-500 dark:text-sky-400" : "text-current opacity-70")}
      aria-label={label}
    />
  );
}

interface ChatMessageBubbleProps {
  message: ChatMessage;
  mine: boolean;
  /** True when the previous message in the run has the same sender. */
  continued?: boolean;
}

export function ChatMessageBubble({ message, mine, continued = false }: ChatMessageBubbleProps) {
  const { language } = useLanguage();
  const time = new Intl.DateTimeFormat(language, { hour: "2-digit", minute: "2-digit" }).format(
    new Date(message.created_at),
  );
  const status = messageStatus(message);

  return (
    <div
      className={cn("flex w-full", mine ? "justify-end" : "justify-start", continued ? "mt-0.5" : "mt-2")}
      data-message-id={message.id}
    >
      <div
        className={cn(
          "relative max-w-[85%] rounded-2xl px-3 py-1.5 text-sm shadow-sm sm:max-w-[70%]",
          mine
            ? "rounded-br-md bg-primary text-primary-foreground"
            : "rounded-bl-md bg-muted text-foreground",
        )}
      >
        <p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{message.body}</p>
        <span
          className={cn(
            "mt-0.5 flex items-center justify-end gap-1 text-[10px] leading-none tabular-nums",
            mine ? "text-primary-foreground/80" : "text-muted-foreground",
          )}
        >
          <time dateTime={message.created_at}>{time}</time>
          {mine ? <ChatStatusIcon status={status} /> : null}
        </span>
      </div>
    </div>
  );
}

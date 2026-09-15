"use client";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Ban, CalendarPlus, Check, CheckCheck, Info, Loader2, MoreHorizontal, Pencil, SmilePlus, Trash2 } from "lucide-react";

import { cn } from "@/lib/utils";
import { useEntitlements } from "@/hooks/use-auth";
import { useLanguage } from "@/hooks/use-language";
import { titleFromMessage } from "@/lib/calendar";
import { EventDrawer } from "@/components/calendar";
import {
  aggregateReactions,
  canDeleteMessage,
  canEditMessage,
  CHAT_STATUS_LABELS,
  groupMessageStatus,
  messageStatus,
  QUICK_REACTIONS,
  receiptRows,
} from "@/lib/chat";
import type { ChatMessage, ChatMessageReaction, ChatMessageReceipt, ChatMessageStatus, ChatThreadMember } from "@/types";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";

import { AttachmentView } from "./attachment-view";

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
  /** Group threads show the sender's name on other people's bubbles. */
  group: boolean;
  /** Members of the thread (receipt aggregation on group messages). */
  members: readonly ChatThreadMember[];
  receipts: readonly ChatMessageReceipt[];
  reactions: readonly ChatMessageReaction[];
  userId: string;
  /** Display name for any user id (sender line, receipt popover). */
  nameOf: (userId: string) => string;
  now: number;
  onReact: (message: ChatMessage, emoji: string) => void;
  onEdit: (message: ChatMessage, body: string) => Promise<void>;
  onDelete: (message: ChatMessage) => Promise<void>;
}

function timeOf(iso: string | null, language: string): string {
  if (!iso) return "";
  return new Intl.DateTimeFormat(language, { hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
}

function ReceiptsPopover({
  message,
  members,
  receipts,
  nameOf,
  mine,
}: Pick<ChatMessageBubbleProps, "message" | "members" | "receipts" | "nameOf" | "mine">) {
  const { t, language } = useLanguage();
  const rows = receiptRows(message, receipts, members);
  const read = rows.filter((r) => r.read_at);
  const delivered = rows.filter((r) => !r.read_at && r.delivered_at);
  const pending = rows.filter((r) => !r.read_at && !r.delivered_at);
  const section = (title: string, list: typeof rows, stamp: (r: (typeof rows)[number]) => string | null) =>
    list.length === 0 ? null : (
      <div key={title}>
        <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{title}</p>
        <ul className="space-y-1">
          {list.map((r) => (
            <li key={r.user_id} className="flex items-center justify-between gap-3 text-sm">
              <span className="truncate text-foreground">{nameOf(r.user_id)}</span>
              <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">{stamp(r) ? timeOf(stamp(r), language) : ""}</span>
            </li>
          ))}
        </ul>
      </div>
    );
  return (
    <Popover>
      <PopoverTrigger
        aria-label={t("Message info")}
        title={t("Message info")}
        className={cn(
          "flex size-7 items-center justify-center rounded-md transition-colors",
          mine ? "text-muted-foreground hover:bg-muted hover:text-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground",
        )}
      >
        <Info className="size-4" />
      </PopoverTrigger>
      <PopoverContent align={mine ? "end" : "start"} side="top" className="w-64 border-border bg-popover p-3">
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("Nobody else in this group yet.")}</p>
        ) : (
          <div className="space-y-3">
            {section(t("Read by"), read, (r) => r.read_at)}
            {section(t("Delivered to"), delivered, (r) => r.delivered_at)}
            {section(t("Pending"), pending, () => null)}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

function ReactionPicker({ onPick, mine }: { onPick: (emoji: string) => void; mine: boolean }) {
  const { t } = useLanguage();
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        aria-label={t("React")}
        title={t("React")}
        className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <SmilePlus className="size-4" />
      </PopoverTrigger>
      <PopoverContent align={mine ? "end" : "start"} side="top" className="w-auto border-border bg-popover p-1">
        <div className="flex gap-0.5" role="listbox" aria-label={t("React")}>
          {QUICK_REACTIONS.map((emoji) => (
            <button
              key={emoji}
              type="button"
              role="option"
              aria-selected={false}
              onClick={() => {
                onPick(emoji);
                setOpen(false);
              }}
              className="flex size-9 items-center justify-center rounded-md text-xl transition-transform hover:scale-125 hover:bg-muted"
            >
              {emoji}
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/**
 * One message: bubble (text and / or attachment), time + status,
 * "edited" / "deleted" states, reaction chips underneath, and a hover /
 * focus toolbar with the quick reaction picker, the receipts popover
 * (own group messages) and the own-message menu (edit within 15 min,
 * delete). Editing happens inline in the bubble.
 */
export function ChatMessageBubble({
  message,
  mine,
  continued = false,
  group,
  members,
  receipts,
  reactions,
  userId,
  nameOf,
  now,
  onReact,
  onEdit,
  onDelete,
}: ChatMessageBubbleProps) {
  const { t, language } = useLanguage();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.body);
  const [busy, setBusy] = useState(false);
  const editRef = useRef<HTMLTextAreaElement | null>(null);
  // "Agendar a partir desta mensagem" (calendar module): the drawer
  // opens prefilled with the message text as title, this thread as the
  // link and the thread's members as attendees.
  const { modules } = useEntitlements();
  const canSchedule = modules.calendar && !message.deleted_at;
  const [scheduleOpen, setScheduleOpen] = useState(false);

  useEffect(() => {
    if (editing) {
      setDraft(message.body);
      const el = editRef.current;
      if (el) {
        el.focus();
        el.setSelectionRange(el.value.length, el.value.length);
      }
    }
  }, [editing, message.body]);

  const deleted = !!message.deleted_at;
  const time = timeOf(message.created_at, language);
  const status: ChatMessageStatus = group ? groupMessageStatus(message, receipts, members) : messageStatus(message);
  const chips = aggregateReactions(reactions, message.id, userId);
  const editable = canEditMessage(message, userId, now);
  const deletable = canDeleteMessage(message, userId);
  const showTools = !deleted;

  const saveEdit = async () => {
    const next = draft.trim();
    if (!next || next === message.body) {
      setEditing(false);
      return;
    }
    setBusy(true);
    try {
      await onEdit(message, next);
      setEditing(false);
    } catch {
      // The panel toasts; keep the editor open.
    } finally {
      setBusy(false);
    }
  };

  const onEditKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      setEditing(false);
    } else if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void saveEdit();
    }
  };

  const remove = async () => {
    if (!window.confirm(t("Delete this message for everyone?"))) return;
    setBusy(true);
    try {
      await onDelete(message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className={cn("group/msg flex w-full flex-col", mine ? "items-end" : "items-start", continued ? "mt-0.5" : "mt-2")}
      data-message-id={message.id}
    >
      {group && !mine && !continued ? (
        <span className="mb-0.5 ml-1 text-[11px] font-medium text-primary">{nameOf(message.sender_id)}</span>
      ) : null}

      <div className={cn("flex max-w-full items-end gap-1", mine ? "flex-row-reverse" : "flex-row")}>
        <div
          className={cn(
            "relative max-w-[85vw] rounded-2xl px-3 py-1.5 text-sm shadow-sm sm:max-w-[28rem]",
            mine ? "rounded-br-md bg-primary text-primary-foreground" : "rounded-bl-md bg-muted text-foreground",
            deleted && "opacity-70",
          )}
        >
          {deleted ? (
            <p className="flex items-center gap-1.5 italic opacity-90">
              <Ban className="size-3.5" />
              {t("Message deleted")}
            </p>
          ) : editing ? (
            <div className="w-64 max-w-full sm:w-80">
              <Textarea
                ref={editRef}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={onEditKey}
                rows={2}
                disabled={busy}
                aria-label={t("Edit message")}
                className={cn(
                  "min-h-16 resize-none text-sm",
                  mine ? "border-primary-foreground/30 bg-primary-foreground/10 text-primary-foreground placeholder:text-primary-foreground/60" : "",
                )}
              />
              <div className="mt-1 flex items-center justify-end gap-2 text-[11px]">
                <span className={cn("mr-auto", mine ? "text-primary-foreground/80" : "text-muted-foreground")}>{t("Editing")} · Esc</span>
                <button type="button" onClick={() => setEditing(false)} disabled={busy} className="rounded px-1.5 py-0.5 hover:underline">
                  {t("Cancel")}
                </button>
                <button
                  type="button"
                  onClick={() => void saveEdit()}
                  disabled={busy || !draft.trim()}
                  className={cn(
                    "rounded px-2 py-0.5 font-semibold",
                    mine ? "bg-primary-foreground/20 hover:bg-primary-foreground/30" : "bg-primary text-primary-foreground hover:bg-primary/90",
                  )}
                >
                  {busy ? <Loader2 className="size-3 animate-spin" /> : t("Save")}
                </button>
              </div>
            </div>
          ) : (
            <>
              {message.attachment ? (
                <div className={cn("-mx-1 mt-0.5", message.body ? "mb-1.5" : "mb-0.5")}>
                  <AttachmentView attachment={message.attachment} mine={mine} />
                </div>
              ) : null}
              {message.body ? (
                <p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{message.body}</p>
              ) : null}
            </>
          )}
          <span
            className={cn(
              "mt-0.5 flex items-center justify-end gap-1 text-[10px] leading-none tabular-nums",
              mine ? "text-primary-foreground/80" : "text-muted-foreground",
            )}
          >
            {message.edited_at && !deleted ? <span className="italic">{t("edited")}</span> : null}
            <time dateTime={message.created_at}>{time}</time>
            {mine && !deleted ? <ChatStatusIcon status={status} /> : null}
          </span>
        </div>

        {showTools && !editing ? (
          <div
            className={cn(
              "flex shrink-0 items-center gap-0.5 self-center opacity-0 transition-opacity focus-within:opacity-100 group-hover/msg:opacity-100 [@media(hover:none)]:opacity-100",
            )}
          >
            <ReactionPicker mine={mine} onPick={(emoji) => onReact(message, emoji)} />
            {mine && group ? (
              <ReceiptsPopover message={message} members={members} receipts={receipts} nameOf={nameOf} mine={mine} />
            ) : null}
            {(mine && (editable || deletable)) || canSchedule ? (
              <DropdownMenu>
                <DropdownMenuTrigger
                  aria-label={t("Message")}
                  className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                  {busy ? <Loader2 className="size-4 animate-spin" /> : <MoreHorizontal className="size-4" />}
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-auto min-w-44 border-border bg-popover">
                  {canSchedule ? (
                    <DropdownMenuItem onClick={() => setScheduleOpen(true)}>
                      <CalendarPlus className="mr-2 size-4" />
                      {t("Schedule from this message")}
                    </DropdownMenuItem>
                  ) : null}
                  {mine && editable ? (
                    <DropdownMenuItem onClick={() => setEditing(true)}>
                      <Pencil className="mr-2 size-4" />
                      {t("Edit message")}
                    </DropdownMenuItem>
                  ) : null}
                  {mine && deletable ? (
                    <DropdownMenuItem onClick={() => void remove()} className="text-destructive focus:text-destructive">
                      <Trash2 className="mr-2 size-4" />
                      {t("Delete message")}
                    </DropdownMenuItem>
                  ) : null}
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
          </div>
        ) : null}
      </div>

      {chips.length > 0 && !deleted ? (
        <div className={cn("mt-0.5 flex flex-wrap gap-1", mine ? "justify-end pr-1" : "justify-start pl-1")}>
          {chips.map((chip) => (
            <button
              key={chip.emoji}
              type="button"
              onClick={() => onReact(message, chip.emoji)}
              aria-pressed={chip.mine}
              title={chip.userIds.map(nameOf).join(", ")}
              className={cn(
                "flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-xs tabular-nums transition-colors",
                chip.mine
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-border bg-card text-muted-foreground hover:bg-muted",
              )}
            >
              <span>{chip.emoji}</span>
              <span>{chip.count}</span>
            </button>
          ))}
        </div>
      ) : null}

      {scheduleOpen ? (
        <EventDrawer
          open={scheduleOpen}
          onOpenChange={setScheduleOpen}
          event={null}
          defaults={{
            title: titleFromMessage(message.body),
            description: message.body,
            chat_thread_id: message.thread_id,
            attendee_user_ids: members.map((m) => m.user_id).filter((id) => id !== userId),
          }}
        />
      ) : null}
    </div>
  );
}

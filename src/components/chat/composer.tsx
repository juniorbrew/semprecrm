"use client";

import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Loader2, SendHorizontal } from "lucide-react";

import { useLanguage } from "@/hooks/use-language";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

interface ChatComposerProps {
  /** Re-focus / clear when the thread changes. */
  threadId: string;
  disabled?: boolean;
  onSend: (body: string) => Promise<void> | void;
  onTyping: () => void;
}

/** Longest message accepted (kept sane for a team chat). */
export const CHAT_MESSAGE_MAX = 4000;

/**
 * Bottom of the thread panel: auto-growing textarea, Enter sends,
 * Shift+Enter breaks the line, explicit send button. Typing raises the
 * (throttled) presence broadcast.
 */
export function ChatComposer({ threadId, disabled = false, onSend, onTyping }: ChatComposerProps) {
  const { t } = useLanguage();
  const [value, setValue] = useState("");
  const [sending, setSending] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // A fresh thread starts with an empty, focused composer.
  useEffect(() => {
    setValue("");
    const el = textareaRef.current;
    if (el && window.matchMedia("(min-width: 1024px)").matches) el.focus();
  }, [threadId]);

  const canSend = !disabled && !sending && value.trim().length > 0;

  const submit = useCallback(async () => {
    const body = value.trim();
    if (!body || sending || disabled) return;
    setSending(true);
    try {
      await onSend(body.slice(0, CHAT_MESSAGE_MAX));
      setValue("");
    } finally {
      setSending(false);
      textareaRef.current?.focus();
    }
  }, [value, sending, disabled, onSend]);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter sends; Shift+Enter (and IME composition) keeps the newline.
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void submit();
    }
  };

  return (
    <form
      className="flex shrink-0 items-end gap-2 border-t border-border bg-card p-3"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <Textarea
        ref={textareaRef}
        value={value}
        onChange={(e) => {
          setValue(e.target.value.slice(0, CHAT_MESSAGE_MAX));
          if (e.target.value.trim()) onTyping();
        }}
        onKeyDown={onKeyDown}
        rows={1}
        disabled={disabled}
        placeholder={t("Type a message")}
        aria-label={t("Message")}
        className="max-h-40 min-h-10 flex-1 resize-none overflow-y-auto py-2.5"
      />
      <Button
        type="submit"
        size="icon"
        disabled={!canSend}
        aria-label={t("Send")}
        title={`${t("Send")} (Enter)`}
        className="size-10 shrink-0 bg-primary text-primary-foreground hover:bg-primary/90"
      >
        {sending ? <Loader2 className="size-4 animate-spin" /> : <SendHorizontal className="size-4" />}
      </Button>
    </form>
  );
}

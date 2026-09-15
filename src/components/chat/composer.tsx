"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
} from "react";
import { FileText, Loader2, Mic, Paperclip, SendHorizontal, Square, X } from "lucide-react";
import { toast } from "sonner";

import { cn } from "@/lib/utils";
import { useLanguage } from "@/hooks/use-language";
import { useVoiceRecorder } from "@/hooks/use-voice-recorder";
import {
  CHAT_ATTACHMENT_ACCEPT,
  formatBytes,
  formatDuration,
  validateChatAttachment,
  type ChatAttachmentKind,
} from "@/lib/chat";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

/** A file staged in the composer, with what we could probe client-side. */
export interface PendingAttachment {
  file: File;
  kind: ChatAttachmentKind;
  mime: string;
  /** Object URL for the local preview (revoked when cleared). */
  previewUrl: string | null;
  width?: number;
  height?: number;
  duration?: number;
}

interface ChatComposerProps {
  /** Re-focus / clear when the thread changes. */
  threadId: string;
  disabled?: boolean;
  onSend: (body: string, attachment: PendingAttachment | null) => Promise<void> | void;
  onTyping: () => void;
}

/** Longest message accepted (kept sane for a team chat). */
export const CHAT_MESSAGE_MAX = 4000;

/** Image size / media duration, best effort (never blocks the send). */
async function probe(file: File, kind: ChatAttachmentKind): Promise<Pick<PendingAttachment, "width" | "height" | "duration">> {
  if (typeof window === "undefined") return {};
  const url = URL.createObjectURL(file);
  try {
    if (kind === "image") {
      return await new Promise((resolve) => {
        const img = new Image();
        img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
        img.onerror = () => resolve({});
        img.src = url;
      });
    }
    if (kind === "audio" || kind === "video") {
      return await new Promise((resolve) => {
        const el = document.createElement(kind);
        const done = () => {
          const d = Number.isFinite(el.duration) ? Math.round(el.duration * 10) / 10 : undefined;
          resolve(
            kind === "video"
              ? { duration: d, width: (el as HTMLVideoElement).videoWidth || undefined, height: (el as HTMLVideoElement).videoHeight || undefined }
              : { duration: d },
          );
        };
        el.preload = "metadata";
        el.onloadedmetadata = done;
        el.onerror = () => resolve({});
        el.src = url;
      });
    }
    return {};
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Bottom of the thread panel: auto-growing textarea (Enter sends,
 * Shift+Enter breaks the line), paperclip / paste / drag-and-drop
 * attachments staged as a chip with a local preview, and a voice
 * recorder that sends the take as soon as it stops. Typing raises the
 * (throttled) presence broadcast.
 */
export function ChatComposer({ threadId, disabled = false, onSend, onTyping }: ChatComposerProps) {
  const { t } = useLanguage();
  const [value, setValue] = useState("");
  const [sending, setSending] = useState(false);
  const [pending, setPending] = useState<PendingAttachment | null>(null);
  const [dragging, setDragging] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const pendingRef = useRef<PendingAttachment | null>(null);
  const dragDepth = useRef(0);
  useEffect(() => {
    pendingRef.current = pending;
  }, [pending]);

  const clearPending = useCallback(() => {
    setPending((prev) => {
      if (prev?.previewUrl) URL.revokeObjectURL(prev.previewUrl);
      return null;
    });
  }, []);

  // A fresh thread starts with an empty, focused composer.
  useEffect(() => {
    setValue("");
    clearPending();
    const el = textareaRef.current;
    if (el && window.matchMedia("(min-width: 1024px)").matches) el.focus();
  }, [threadId, clearPending]);

  // Revoke the preview URL on unmount.
  useEffect(() => {
    return () => {
      if (pendingRef.current?.previewUrl) URL.revokeObjectURL(pendingRef.current.previewUrl);
    };
  }, []);

  const rejectionMessage = (reason: "empty" | "too_large" | "unsupported_type") =>
    reason === "too_large" ? t("File is too large (max 25 MB).") : reason === "empty" ? t("The file is empty.") : t("File type not supported.");

  const stage = useCallback(
    async (file: File) => {
      const check = validateChatAttachment(file);
      if (!check.ok) {
        toast.error(rejectionMessage(check.reason));
        return false;
      }
      const meta = await probe(file, check.kind);
      const previewUrl = check.kind === "image" || check.kind === "video" ? URL.createObjectURL(file) : null;
      setPending((prev) => {
        if (prev?.previewUrl) URL.revokeObjectURL(prev.previewUrl);
        return { file, kind: check.kind, mime: check.mime, previewUrl, ...meta };
      });
      textareaRef.current?.focus();
      return true;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `t` is stable per language
    [],
  );

  const canSend = !disabled && !sending && (value.trim().length > 0 || pending !== null);

  const submit = useCallback(async () => {
    const body = value.trim();
    if ((!body && !pending) || sending || disabled) return;
    setSending(true);
    try {
      await onSend(body.slice(0, CHAT_MESSAGE_MAX), pending);
      // Drop only what was sent: anything typed while the request was in
      // flight stays in the box.
      const sent = value;
      setValue((current) => (current.startsWith(sent) ? current.slice(sent.length).trimStart() : current));
      clearPending();
    } catch {
      // The panel toasts; keep the draft so the user can retry.
    } finally {
      setSending(false);
      // Refocus after React commits the re-render: focusing a control the
      // browser just blurred (or one still marked disabled) is a no-op.
      requestAnimationFrame(() => textareaRef.current?.focus());
    }
  }, [value, pending, sending, disabled, onSend, clearPending]);

  // ---- voice ---------------------------------------------------------
  const recorder = useVoiceRecorder({
    onRecorded: (file, seconds) => {
      const check = validateChatAttachment(file);
      if (!check.ok) {
        toast.error(rejectionMessage(check.reason));
        return;
      }
      setSending(true);
      Promise.resolve(onSend("", { file, kind: "audio", mime: check.mime, previewUrl: null, duration: seconds }))
        .catch(() => {})
        .finally(() => setSending(false));
    },
    onError: (reason) =>
      toast.error(reason === "unsupported" ? t("Voice recording isn't supported in this browser.") : t("Microphone access denied or unavailable.")),
  });

  // ---- input handlers -------------------------------------------------
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter sends; Shift+Enter (and IME composition) keeps the newline.
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void submit();
    }
  };

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const items = Array.from(e.clipboardData?.items ?? []);
    const fileItem = items.find((it) => it.kind === "file");
    if (!fileItem) return;
    const file = fileItem.getAsFile();
    if (!file) return;
    e.preventDefault();
    const named = file.name && file.name !== "image.png" ? file : new File([file], `pasted-${Date.now()}.${(file.type.split("/")[1] || "png").replace("jpeg", "jpg")}`, { type: file.type });
    void stage(named);
  };

  const onDragEnter = (e: DragEvent<HTMLElement>) => {
    if (disabled || !Array.from(e.dataTransfer.types).includes("Files")) return;
    e.preventDefault();
    dragDepth.current += 1;
    setDragging(true);
  };
  const onDragLeave = (e: DragEvent<HTMLElement>) => {
    e.preventDefault();
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragging(false);
  };
  const onDragOver = (e: DragEvent<HTMLElement>) => {
    if (disabled) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  };
  const onDrop = (e: DragEvent<HTMLElement>) => {
    e.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    if (disabled) return;
    const file = e.dataTransfer.files?.[0];
    if (file) void stage(file);
  };

  const inputsDisabled = disabled || sending || recorder.recording;

  return (
    <form
      className={cn(
        "relative flex shrink-0 flex-col gap-2 border-t border-border bg-card p-3 transition-colors",
        dragging && "bg-primary/5",
      )}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      {dragging ? (
        <div className="pointer-events-none absolute inset-1 z-10 flex items-center justify-center rounded-lg border-2 border-dashed border-primary bg-card/90 text-sm font-medium text-primary">
          {t("Drop the file to attach it")}
        </div>
      ) : null}

      {pending ? (
        <div className="flex items-center gap-3 rounded-lg border border-border bg-muted/60 p-2" aria-live="polite">
          {pending.kind === "image" && pending.previewUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- local object URL preview
            <img src={pending.previewUrl} alt={pending.file.name} className="size-14 shrink-0 rounded-md object-cover" />
          ) : pending.kind === "video" && pending.previewUrl ? (
            <video src={pending.previewUrl} muted className="size-14 shrink-0 rounded-md bg-black object-cover" />
          ) : (
            <span className="flex size-14 shrink-0 items-center justify-center rounded-md bg-background text-muted-foreground">
              {pending.kind === "audio" ? <Mic className="size-5" /> : <FileText className="size-5" />}
            </span>
          )}
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium text-foreground">{pending.file.name}</span>
            <span className="block text-xs text-muted-foreground">
              {sending ? t("Uploading…") : formatBytes(pending.file.size)}
              {pending.duration ? ` · ${formatDuration(pending.duration)}` : ""}
              {pending.width && pending.height ? ` · ${pending.width}×${pending.height}` : ""}
            </span>
          </span>
          {sending ? (
            <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" />
          ) : (
            <button
              type="button"
              onClick={clearPending}
              aria-label={t("Remove attachment")}
              title={t("Remove attachment")}
              className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-background hover:text-foreground"
            >
              <X className="size-4" />
            </button>
          )}
        </div>
      ) : null}

      {recorder.recording ? (
        <div className="flex items-center gap-3 rounded-xl border border-border bg-muted px-4 py-2.5">
          <span className="size-2.5 shrink-0 animate-pulse rounded-full bg-red-500" />
          <span className="flex-1 text-sm text-foreground" aria-live="polite">
            {t("Recording…")} {formatDuration(recorder.seconds)} / {formatDuration(recorder.maxSeconds)}
          </span>
          <button
            type="button"
            onClick={recorder.cancel}
            className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-card hover:text-foreground"
          >
            {t("Cancel")}
          </button>
          <Button
            type="button"
            size="icon"
            onClick={recorder.stop}
            aria-label={t("Stop and send")}
            title={t("Stop and send")}
            className="size-9 shrink-0 bg-primary text-primary-foreground hover:bg-primary/90"
          >
            <Square className="size-4" />
          </Button>
        </div>
      ) : (
        <div className="flex items-end gap-1.5">
          <input
            ref={fileInputRef}
            type="file"
            accept={CHAT_ATTACHMENT_ACCEPT}
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file) void stage(file);
            }}
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={inputsDisabled}
            aria-label={t("Attach file")}
            title={t("Attach file")}
            className="flex size-10 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Paperclip className="size-4" />
          </button>
          <Textarea
            ref={textareaRef}
            value={value}
            onChange={(e) => {
              setValue(e.target.value.slice(0, CHAT_MESSAGE_MAX));
              if (e.target.value.trim()) onTyping();
            }}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            rows={1}
            // Stay editable while a send is in flight so the caret never
            // leaves the box: Enter → message goes out → keep typing.
            disabled={disabled}
            placeholder={t("Type a message")}
            aria-label={t("Message")}
            className="max-h-40 min-h-10 flex-1 resize-none overflow-y-auto py-2.5"
          />
          {canSend ? (
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
          ) : (
            <Button
              type="button"
              size="icon"
              disabled={inputsDisabled}
              onClick={() => void recorder.start()}
              aria-label={t("Record voice message")}
              title={t("Record voice message")}
              className="size-10 shrink-0 bg-primary text-primary-foreground hover:bg-primary/90"
            >
              {sending ? <Loader2 className="size-4 animate-spin" /> : <Mic className="size-4" />}
            </Button>
          )}
        </div>
      )}
    </form>
  );
}

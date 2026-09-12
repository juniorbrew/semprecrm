"use client";

import {
  useState,
  useRef,
  useCallback,
  useEffect,
  KeyboardEvent,
} from "react";
import {
  Send,
  LayoutTemplate,
  Paperclip,
  Image as ImageIcon,
  Video,
  FileText,
  Mic,
  Square,
  X,
  Loader2,
  Lock,
  MessageSquareReply,
  SmilePlus,
  Clock,
  Bold,
  Italic,
  Strikethrough,
  Code,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { GatedButton } from "@/components/ui/gated-button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useCan } from "@/hooks/use-can";
import { useLanguage } from "@/hooks/use-language";
import type { Language } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import {
  uploadAccountMedia,
  deleteAccountMedia,
  MEDIA_MAX_BYTES_BY_KIND,
} from "@/lib/storage/upload-media";
import { ReplyQuote } from "./reply-quote";

/** Media content types an agent can send from the composer. */
export type ComposerMediaKind = "image" | "video" | "document" | "audio";

/** Supabase Storage bucket holding agent-sent chat attachments (migration 023). */
export const CHAT_MEDIA_BUCKET = "chat-media";

/** Meta caps media captions at 1024 chars. Enforced here and in the send route. */
export const MEDIA_CAPTION_MAX = 1024;

/** Hard cap on a single voice recording so it can't blow the upload/
 *  transcode limits — auto-stops the recorder when reached. */
const MAX_RECORDING_SECONDS = 5 * 60;

export interface SendMediaPayload {
  kind: ComposerMediaKind;
  /** Public chat-media URL Meta fetches at send time. */
  mediaUrl: string;
  /** Storage object path — lets the caller GC the object if the send fails. */
  path: string;
  /** Optional caption (image/video/document only). */
  caption?: string;
  /** Original file name — surfaced to the recipient for documents. */
  filename?: string;
  replyToId?: string;
}

interface ReplyDraft {
  /** Internal UUID of the message being replied to — sent back through onSend. */
  id: string;
  authorLabel: string;
  preview: string;
}

// Mirrors the chat-media bucket's allowed_mime_types (migration 023) for
// the file picker so unsupported files are rejected before upload rather
// than failing with a confusing Storage error. Audio has no picker — it's
// captured via the recorder.
const PICKER_ACCEPT: Record<"image" | "video" | "document", string> = {
  image: "image/png,image/jpeg,image/webp",
  video: "video/mp4,video/3gpp",
  document:
    "application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-powerpoint,application/vnd.openxmlformats-officedocument.presentationml.presentation,text/plain",
};

interface MediaDraft {
  kind: ComposerMediaKind;
  mediaUrl: string;
  /** Storage path — used to GC the object if the draft is discarded. */
  path: string;
  filename: string;
  caption: string;
}

/** What the composer produces: a WhatsApp reply or a team-only note. */
export type ComposerMode = "reply" | "note";

interface MessageComposerProps {
  conversationId: string;
  sessionExpired: boolean;
  onSend: (text: string, replyToId?: string) => void;
  onSendMedia: (payload: SendMediaPayload) => void;
  onOpenTemplates: () => void;
  /**
   * Internal note submit. Notes never touch the WhatsApp API — the parent
   * stores them on the contact and renders them inline in the thread.
   * The "Nota interna" tab only renders when this is provided.
   */
  onSendNote?: (text: string) => Promise<void> | void;
  replyTo?: ReplyDraft | null;
  onClearReply?: () => void;
}

/**
 * Composer copy is language-keyed (not routed through the DOM catalogue)
 * because several strings interpolate or are mode-dependent; the elements
 * are marked `data-no-translate` so the translator leaves them alone.
 */
const COMPOSER_COPY: Record<
  Language,
  {
    reply: string;
    note: string;
    replyPlaceholder: string;
    notePlaceholder: string;
    expiredPlaceholder: string;
    readOnlyPlaceholder: string;
    expiredLine: string;
    templates: string;
    sendTemplate: string;
    addNote: string;
    send: string;
    emoji: string;
    attach: string;
    noteHint: string;
    replyHint: string;
    attachNotInNote: string;
    readOnlyTitle: string;
    bold: string;
    italic: string;
    strike: string;
    mono: string;
    slashHint: string;
  }
> = {
  "pt-BR": {
    reply: "Responder",
    note: "Nota interna",
    replyPlaceholder: "Digite uma mensagem… Shift+Enter para nova linha. Digite / para modelos",
    notePlaceholder: "Escreva uma nota para a equipe — o cliente não vê",
    expiredPlaceholder: "Janela de 24 h encerrada — envie um modelo",
    readOnlyPlaceholder: "Somente leitura — seu perfil não pode responder",
    expiredLine:
      "Janela de 24 h encerrada: o WhatsApp só aceita modelos aprovados até o cliente responder de novo.",
    templates: "Modelos",
    sendTemplate: "Enviar modelo",
    addNote: "Adicionar nota",
    send: "Enviar",
    emoji: "Emoji",
    attach: "Anexar mídia",
    noteHint: "Visível só para a equipe · nunca vai para o WhatsApp",
    replyHint: "Enter envia · Shift+Enter quebra linha",
    attachNotInNote: "Anexos só em respostas",
    readOnlyTitle: "Somente leitura — seu perfil não pode enviar mensagens",
    bold: "Negrito (Ctrl+B)",
    italic: "Itálico (Ctrl+I)",
    strike: "Tachado",
    mono: "Monoespaçado",
    slashHint: "para modelos",
  },
  "en-US": {
    reply: "Reply",
    note: "Private note",
    replyPlaceholder: "Type a message… Shift+Enter for a new line. Type / for templates",
    notePlaceholder: "Write a note for your team — the customer won't see it",
    expiredPlaceholder: "24-hour window closed — send a template",
    readOnlyPlaceholder: "Read-only — your role can't reply",
    expiredLine:
      "24-hour window closed: WhatsApp only accepts approved templates until the customer replies again.",
    templates: "Templates",
    sendTemplate: "Send template",
    addNote: "Add note",
    send: "Send",
    emoji: "Emoji",
    attach: "Attach media",
    noteHint: "Visible to your team only · never sent to WhatsApp",
    replyHint: "Enter sends · Shift+Enter for a new line",
    attachNotInNote: "Attachments only on replies",
    readOnlyTitle: "Read-only — your role can't send messages",
    bold: "Bold (Ctrl+B)",
    italic: "Italic (Ctrl+I)",
    strike: "Strikethrough",
    mono: "Monospace",
    slashHint: "for templates",
  },
};

// Small curated grid instead of a full emoji library (keeps the bundle
// flat; the reaction picker takes the same approach). Grouped loosely:
// faces, gestures, objects/business, symbols.
const COMPOSER_EMOJIS = [
  "😀", "😄", "😂", "🙂", "😉", "😍", "🤔", "😅", "😎", "🙏",
  "👍", "👏", "🤝", "👋", "✅", "❌", "⚠️", "⭐", "🔥", "🎉",
  "📦", "🚚", "💳", "💰", "📅", "⏰", "📍", "📞", "📎", "💬",
  "❤️", "💙", "💚", "✨", "🙌", "😢", "😮", "🤷", "👀", "🥳",
];

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/** Worker that encodes mic input to Ogg/Opus entirely in the browser
 *  (vendored from opus-recorder into /public). Recording client-side in a
 *  Meta-accepted format means no server ffmpeg / transcode step. */
const OPUS_ENCODER_PATH = "/opus/encoderWorker.min.js";

export function MessageComposer({
  conversationId,
  sessionExpired,
  onSend,
  onSendMedia,
  onOpenTemplates,
  onSendNote,
  replyTo,
  onClearReply,
}: MessageComposerProps) {
  const { language } = useLanguage();
  const copy = COMPOSER_COPY[language] ?? COMPOSER_COPY["pt-BR"];
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Reply vs internal note. Reset when the thread changes so a half-typed
  // note for contact A can't be posted as a WhatsApp reply to contact B.
  const [mode, setMode] = useState<ComposerMode>("reply");
  const [emojiOpen, setEmojiOpen] = useState(false);
  useEffect(() => {
    setMode("reply");
    setText("");
  }, [conversationId]);
  const isNote = mode === "note" && !!onSendNote;

  // Media attachment state. `draft` holds an uploaded-but-not-yet-sent
  // attachment; `busy` covers the upload/transcode window.
  const [draft, setDraft] = useState<MediaDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const videoInputRef = useRef<HTMLInputElement>(null);
  const documentInputRef = useRef<HTMLInputElement>(null);
  // Mirror of `draft` for the unmount cleanup, which can't read render
  // state. Kept in sync below so navigating away with a staged-but-unsent
  // attachment GCs the orphaned object.
  const draftRef = useRef<MediaDraft | null>(null);
  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  // Best-effort GC of a staged object the user never sent. Fire-and-forget.
  const removeStaged = useCallback((path: string | undefined) => {
    if (!path) return;
    void deleteAccountMedia(CHAT_MEDIA_BUCKET, path).catch(() => {});
  }, []);

  // Voice recording state. The recorder encodes Ogg/Opus in-browser
  // (opus-recorder) so there's no server-side transcode.
  const [recording, setRecording] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);
  const recorderRef = useRef<import("opus-recorder").default | null>(null);
  const cancelledRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Viewers (read-only role) can browse the inbox but never send.
  // For solo users this is always true — single-owner accounts pass
  // every capability — so the disabled branch is a no-op there.
  const canSend = useCan("send-messages");
  const readOnly = !canSend;
  // Media (like free-form text) is only allowed inside the 24h window.
  const inputsDisabled = readOnly || sessionExpired;

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  // Tear down any live recording + timer on unmount so a mid-record
  // navigation doesn't leak the mic, and GC a staged-but-unsent
  // attachment so it doesn't orphan in the bucket.
  useEffect(() => {
    return () => {
      clearTimer();
      cancelledRef.current = true;
      // stop() releases the mic stream + audio context inside opus-recorder.
      void recorderRef.current?.stop().catch(() => {});
      removeStaged(draftRef.current?.path);
    };
  }, [clearTimer, removeStaged]);

  const adjustHeight = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    // Max 4 lines (~96px)
    el.style.height = `${Math.min(el.scrollHeight, 96)}px`;
  }, []);

  const handleSend = useCallback(async () => {
    const trimmed = text.trim();
    if (!trimmed || sending) return;
    // Notes bypass the 24h window entirely — they never reach WhatsApp.
    if (!isNote && sessionExpired) return;

    setSending(true);
    try {
      if (isNote) {
        await onSendNote?.(trimmed);
      } else {
        onSend(trimmed, replyTo?.id);
      }
      setText("");
      if (textareaRef.current) {
        textareaRef.current.style.height = "auto";
      }
    } finally {
      setSending(false);
    }
  }, [text, sending, sessionExpired, isNote, onSendNote, onSend, replyTo?.id]);

  // Drop an emoji at the caret (or append) and keep focus in the box.
  const insertEmoji = useCallback(
    (emoji: string) => {
      const el = textareaRef.current;
      if (!el) {
        setText((t) => t + emoji);
        return;
      }
      const start = el.selectionStart ?? el.value.length;
      const end = el.selectionEnd ?? start;
      const next = el.value.slice(0, start) + emoji + el.value.slice(end);
      setText(next);
      setEmojiOpen(false);
      requestAnimationFrame(() => {
        el.focus();
        const caret = start + emoji.length;
        el.setSelectionRange(caret, caret);
        adjustHeight();
      });
    },
    [adjustHeight],
  );

  // Wrap the selection in WhatsApp markdown (*bold*, _italic_, ~strike~,
  // ```mono```). With nothing selected the markers are inserted and the
  // caret lands between them, so the agent can just keep typing.
  const wrapSelection = useCallback(
    (marker: string) => {
      const el = textareaRef.current;
      if (!el || el.disabled) return;
      const start = el.selectionStart ?? el.value.length;
      const end = el.selectionEnd ?? start;
      const selected = el.value.slice(start, end);
      const next =
        el.value.slice(0, start) + marker + selected + marker + el.value.slice(end);
      setText(next);
      requestAnimationFrame(() => {
        el.focus();
        if (selected) {
          el.setSelectionRange(start, end + marker.length * 2);
        } else {
          const caret = start + marker.length;
          el.setSelectionRange(caret, caret);
        }
        adjustHeight();
      });
    },
    [adjustHeight],
  );

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
        return;
      }
      // "/" on an empty reply opens the template picker (canned
      // responses), Chatwoot-style. Notes have no templates.
      if (
        e.key === "/" &&
        !isNote &&
        !readOnly &&
        e.currentTarget.value.length === 0 &&
        !e.ctrlKey &&
        !e.metaKey &&
        !e.altKey
      ) {
        e.preventDefault();
        onOpenTemplates();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !isNote) {
        const key = e.key.toLowerCase();
        if (key === "b") {
          e.preventDefault();
          wrapSelection("*");
        } else if (key === "i") {
          e.preventDefault();
          wrapSelection("_");
        }
      }
    },
    [handleSend, isNote, readOnly, onOpenTemplates, wrapSelection]
  );

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      setText(e.target.value);
      adjustHeight();
    },
    [adjustHeight]
  );

  // Upload a captured file to chat-media and stage it as a draft.
  const stageUpload = useCallback(
    async (kind: ComposerMediaKind, file: File) => {
      // Per-kind ceiling mirrors Meta's caps (image 5 MB, etc.) so we
      // reject before upload rather than orphaning an object that Meta
      // would then refuse at send.
      const max = MEDIA_MAX_BYTES_BY_KIND[kind];
      if (file.size > max) {
        toast.error(
          `File is ${(file.size / 1024 / 1024).toFixed(1)} MB — ${kind} limit is ${Math.round(
            max / 1024 / 1024,
          )} MB.`,
        );
        return;
      }
      setBusy(true);
      try {
        const { publicUrl, path } = await uploadAccountMedia(CHAT_MEDIA_BUCKET, file);
        // Replacing an existing draft? GC the previous object first.
        removeStaged(draftRef.current?.path);
        setDraft({ kind, mediaUrl: publicUrl, path, filename: file.name, caption: "" });
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Upload failed.");
      } finally {
        setBusy(false);
      }
    },
    [removeStaged],
  );

  const handlePicked = useCallback(
    (kind: "image" | "video" | "document", file: File | undefined) => {
      if (file) void stageUpload(kind, file);
    },
    [stageUpload],
  );

  // ---- Voice recording (client-side Ogg/Opus, no server transcode) ---

  // The encoded Ogg/Opus file from opus-recorder → upload as an audio
  // draft. WhatsApp renders Ogg/Opus as a playable voice note.
  const finalizeRecording = useCallback(
    async (bytes: Uint8Array) => {
      // Uint8Array is a valid BlobPart at runtime; the cast sidesteps the
      // lib.dom ArrayBufferLike-vs-ArrayBuffer generic mismatch.
      const file = new File([bytes as unknown as BlobPart], `voice-${Date.now()}.ogg`, {
        type: "audio/ogg",
      });
      if (file.size === 0) return; // cancelled / empty take
      if (file.size > MEDIA_MAX_BYTES_BY_KIND.audio) {
        toast.error("Recording is too long (over 16 MB).");
        return;
      }
      setBusy(true);
      try {
        const { publicUrl, path } = await uploadAccountMedia(CHAT_MEDIA_BUCKET, file);
        removeStaged(draftRef.current?.path);
        setDraft({ kind: "audio", mediaUrl: publicUrl, path, filename: file.name, caption: "" });
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Upload failed.");
      } finally {
        setBusy(false);
      }
    },
    [removeStaged],
  );

  const startRecording = useCallback(async () => {
    if (inputsDisabled || busy || recording) return;
    if (!navigator.mediaDevices?.getUserMedia || typeof AudioContext === "undefined") {
      toast.error("Voice recording isn't supported in this browser.");
      return;
    }
    try {
      // Lazy-load the encoder (≈400 KB worker) only when the user records,
      // keeping it out of the main bundle.
      const { default: Recorder } = await import("opus-recorder");
      const recorder = new Recorder({
        encoderPath: OPUS_ENCODER_PATH,
        numberOfChannels: 1,
        encoderApplication: 2048, // VOIP — tuned for speech
        encoderSampleRate: 48000,
        streamPages: false, // one callback with the complete file on stop
      });
      cancelledRef.current = false;
      recorder.ondataavailable = (bytes) => {
        if (cancelledRef.current) return;
        void finalizeRecording(bytes);
      };
      recorderRef.current = recorder;
      await recorder.start();
      setRecording(true);
      setRecordSeconds(0);
      timerRef.current = setInterval(() => setRecordSeconds((s) => s + 1), 1000);
    } catch {
      void recorderRef.current?.stop().catch(() => {});
      recorderRef.current = null;
      toast.error("Microphone access denied or unavailable.");
    }
  }, [inputsDisabled, busy, recording, finalizeRecording]);

  const stopRecording = useCallback(() => {
    clearTimer();
    setRecording(false);
    void recorderRef.current?.stop().catch(() => {});
  }, [clearTimer]);

  const cancelRecording = useCallback(() => {
    cancelledRef.current = true;
    clearTimer();
    setRecording(false);
    void recorderRef.current?.stop().catch(() => {});
  }, [clearTimer]);

  // Auto-stop at the cap so a forgotten recording can't blow the
  // upload size limit.
  useEffect(() => {
    if (recording && recordSeconds >= MAX_RECORDING_SECONDS) {
      stopRecording();
    }
  }, [recording, recordSeconds, stopRecording]);

  // ---- Draft send / discard -----------------------------------------

  const sendDraft = useCallback(() => {
    if (!draft || busy) return;
    onSendMedia({
      kind: draft.kind,
      mediaUrl: draft.mediaUrl,
      path: draft.path,
      // Audio takes no caption (Meta rejects it). Everything else: the
      // trimmed caption, or undefined when blank.
      caption:
        draft.kind === "audio" ? undefined : draft.caption.trim() || undefined,
      filename: draft.kind === "document" ? draft.filename : undefined,
      replyToId: replyTo?.id,
    });
    // The object is now owned by the sent message — clear without GC.
    setDraft(null);
    onClearReply?.();
  }, [draft, busy, onSendMedia, replyTo?.id, onClearReply]);

  // Discard GCs the staged object — it was uploaded but never sent.
  const discardDraft = useCallback(() => {
    removeStaged(draft?.path);
    setDraft(null);
  }, [draft?.path, removeStaged]);

  const setCaption = useCallback((caption: string) => {
    setDraft((d) => (d ? { ...d, caption } : d));
  }, []);

  // ---- Render --------------------------------------------------------

  // Free-form WhatsApp text is gated by the 24h window; notes are not.
  const textDisabled = readOnly || (sessionExpired && !isNote);
  const sendLabel = isNote ? copy.addNote : copy.send;
  const placeholder = readOnly
    ? copy.readOnlyPlaceholder
    : isNote
      ? copy.notePlaceholder
      : sessionExpired
        ? copy.expiredPlaceholder
        : copy.replyPlaceholder;

  return (
    <div
      className={cn(
        "border-t border-border bg-card p-3 transition-colors",
        isNote && "bg-amber-500/[0.04]",
      )}
    >
      {replyTo && !isNote && (
        <div className="mb-2">
          <ReplyQuote
            authorLabel={replyTo.authorLabel}
            preview={replyTo.preview}
            onDismiss={onClearReply}
          />
        </div>
      )}

      {/* Mode switch — Responder | Nota interna. Notes are the team
          layer: stored on the contact, rendered as amber bubbles in the
          thread, never sent to WhatsApp. */}
      {onSendNote && (
        <div
          className="mb-2 flex items-center justify-between gap-3"
          data-no-translate
        >
          <div
            role="tablist"
            aria-label={`${copy.reply} / ${copy.note}`}
            className="inline-flex shrink-0 items-center rounded-lg bg-muted p-0.5"
          >
            <button
              type="button"
              role="tab"
              aria-selected={!isNote}
              onClick={() => setMode("reply")}
              className={cn(
                "inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition-colors",
                !isNote
                  ? "bg-card text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <MessageSquareReply className="h-3.5 w-3.5" />
              {copy.reply}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={isNote}
              onClick={() => setMode("note")}
              className={cn(
                "inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition-colors",
                isNote
                  ? "bg-amber-500/20 text-amber-600 shadow-sm dark:text-amber-400"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <Lock className="h-3.5 w-3.5" />
              {copy.note}
            </button>
          </div>
          <p className="hidden min-w-0 truncate text-[10px] text-muted-foreground sm:block">
            {isNote ? copy.noteHint : copy.replyHint}
          </p>
        </div>
      )}

      {/* Expired 24h window — one line of explanation; the template
          path stays open (Meta accepts approved templates any time). */}
      {sessionExpired && !isNote && !readOnly && (
        <div
          data-no-translate
          className="mb-2 flex items-center gap-2 rounded-lg border border-amber-500/20 bg-amber-500/10 px-3 py-1.5"
        >
          <Clock className="h-3.5 w-3.5 shrink-0 text-amber-500" />
          <p className="min-w-0 flex-1 text-xs leading-snug text-amber-600 dark:text-amber-400">
            {copy.expiredLine}
          </p>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 shrink-0 gap-1 px-2 text-xs text-amber-600 hover:text-amber-700 dark:text-amber-400 dark:hover:text-amber-300"
            onClick={onOpenTemplates}
          >
            <LayoutTemplate className="h-3.5 w-3.5" />
            {copy.sendTemplate}
          </Button>
        </div>
      )}

      {/* Hidden file inputs driven by the attach menu. */}
      <input
        ref={imageInputRef}
        type="file"
        accept={PICKER_ACCEPT.image}
        className="hidden"
        onChange={(e) => {
          handlePicked("image", e.target.files?.[0]);
          e.target.value = "";
        }}
      />
      <input
        ref={videoInputRef}
        type="file"
        accept={PICKER_ACCEPT.video}
        className="hidden"
        onChange={(e) => {
          handlePicked("video", e.target.files?.[0]);
          e.target.value = "";
        }}
      />
      <input
        ref={documentInputRef}
        type="file"
        accept={PICKER_ACCEPT.document}
        className="hidden"
        onChange={(e) => {
          handlePicked("document", e.target.files?.[0]);
          e.target.value = "";
        }}
      />

      {draft ? (
        <MediaDraftPreview
          draft={draft}
          busy={busy}
          readOnly={readOnly}
          onCaptionChange={setCaption}
          onDiscard={discardDraft}
          onSend={sendDraft}
        />
      ) : recording ? (
        // Recording bar — replaces the composer while the mic is live.
        <div className="flex items-center gap-3 rounded-xl border border-border bg-muted px-4 py-2.5">
          <span className="flex h-2.5 w-2.5 shrink-0 animate-pulse rounded-full bg-red-500" />
          <span className="flex-1 text-sm text-foreground">
            Recording… {formatDuration(recordSeconds)} /{" "}
            {formatDuration(MAX_RECORDING_SECONDS)}
          </span>
          <button
            type="button"
            onClick={cancelRecording}
            className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-card hover:text-foreground"
          >
            Cancelar
          </button>
          <Button
            size="sm"
            onClick={stopRecording}
            className="h-9 w-9 shrink-0 bg-primary p-0 hover:bg-primary/90"
            title="Stop and attach"
          >
            <Square className="h-4 w-4" />
          </Button>
        </div>
      ) : (
        // Workbench: textarea on top, toolbar row underneath. The
        // toolbar stays visible in every state so the composer never
        // collapses into a bare disabled input.
        <div
          className={cn(
            "rounded-xl border bg-muted transition-colors focus-within:border-primary/50",
            isNote
              ? "border-dashed border-amber-500/50 bg-amber-500/10 focus-within:border-amber-500/80"
              : "border-border",
            textDisabled && "opacity-70",
          )}
        >
          {/* Formatting strip — reply mode only. WhatsApp renders these
              markers natively, so what the agent types is what the
              customer sees. The "/" hint mirrors the placeholder for
              when there is already text in the box. */}
          {!isNote && (
            <div
              data-no-translate
              className="flex items-center gap-0.5 border-b border-border/60 px-1.5 py-1"
            >
              {(
                [
                  { icon: Bold, label: copy.bold, marker: "*" },
                  { icon: Italic, label: copy.italic, marker: "_" },
                  { icon: Strikethrough, label: copy.strike, marker: "~" },
                  { icon: Code, label: copy.mono, marker: "```" },
                ] as const
              ).map(({ icon: Icon, label, marker }) => (
                <button
                  key={marker}
                  type="button"
                  tabIndex={-1}
                  disabled={textDisabled}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => wrapSelection(marker)}
                  aria-label={label}
                  title={label}
                  className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-card hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <Icon className="h-3.5 w-3.5" />
                </button>
              ))}
              <span className="mx-1 h-3.5 w-px bg-border" aria-hidden="true" />
              <button
                type="button"
                tabIndex={-1}
                disabled={readOnly}
                onClick={onOpenTemplates}
                title={copy.sendTemplate}
                className="inline-flex h-6 items-center gap-1 rounded px-1.5 text-[11px] text-muted-foreground transition-colors hover:bg-card hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
              >
                <kbd className="rounded border border-border bg-card px-1 font-mono text-[10px] leading-4 text-foreground/80">
                  /
                </kbd>
                <span className="hidden sm:inline">{copy.slashHint}</span>
              </button>
            </div>
          )}
          <textarea
            ref={textareaRef}
            value={text}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
            disabled={textDisabled}
            rows={1}
            data-no-translate
            aria-label={isNote ? copy.note : copy.reply}
            title={readOnly ? copy.readOnlyTitle : undefined}
            className={cn(
              // text-base below sm: iOS Safari zooms the page on focus for
              // inputs under 16 px (mobile critic r0).
              "block w-full resize-none bg-transparent px-3.5 pb-1 pt-2.5 text-base text-foreground placeholder-muted-foreground outline-none sm:text-sm",
              textDisabled && "cursor-not-allowed",
            )}
          />

          <div className="flex items-center gap-0.5 px-1.5 pb-1.5">
            {/* Emoji — works for replies and notes alike. */}
            <Popover open={emojiOpen} onOpenChange={setEmojiOpen}>
              <PopoverTrigger
                disabled={textDisabled}
                aria-label={copy.emoji}
                title={copy.emoji}
                className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-card hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
              >
                <SmilePlus className="h-4 w-4" />
              </PopoverTrigger>
              <PopoverContent
                align="start"
                side="top"
                className="w-auto border-border bg-popover p-2"
              >
                <div
                  className="grid grid-cols-10 gap-0.5"
                  role="listbox"
                  aria-label={copy.emoji}
                >
                  {COMPOSER_EMOJIS.map((emoji) => (
                    <button
                      key={emoji}
                      type="button"
                      role="option"
                      aria-selected={false}
                      onClick={() => insertEmoji(emoji)}
                      className="flex h-7 w-7 items-center justify-center rounded text-base leading-none transition-colors hover:bg-muted"
                    >
                      {emoji}
                    </button>
                  ))}
                </div>
              </PopoverContent>
            </Popover>

            {/* Attach menu — photo / video / document / voice. */}
            <DropdownMenu>
              <DropdownMenuTrigger
                disabled={inputsDisabled || busy || isNote}
                aria-label={copy.attach}
                title={
                  readOnly
                    ? copy.readOnlyTitle
                    : isNote
                      ? copy.attachNotInNote
                      : sessionExpired
                        ? copy.expiredPlaceholder
                        : copy.attach
                }
                className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-card hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
              >
                {busy ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Paperclip className="h-4 w-4" />
                )}
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="border-border bg-popover">
                <DropdownMenuItem onClick={() => imageInputRef.current?.click()}>
                  <ImageIcon className="mr-2 h-4 w-4" />
                  Foto
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => videoInputRef.current?.click()}>
                  <Video className="mr-2 h-4 w-4" />
                  Vídeo
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => documentInputRef.current?.click()}>
                  <FileText className="mr-2 h-4 w-4" />
                  Documento
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => void startRecording()}>
                  <Mic className="mr-2 h-4 w-4" />
                  Mensagem de voz
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>

            {/* Voice note — one tap from the toolbar. */}
            <button
              type="button"
              disabled={inputsDisabled || busy || isNote}
              onClick={() => void startRecording()}
              aria-label="Mensagem de voz"
              title={isNote ? copy.attachNotInNote : "Mensagem de voz"}
              className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-card hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Mic className="h-4 w-4" />
            </button>

            {/* Templates — the only WhatsApp path once the window
                closes, so it lights up in that state. Hidden for notes. */}
            {!isNote && (
              <GatedButton
                variant="ghost"
                size="sm"
                canAct={!readOnly}
                gateReason="send messages"
                title={readOnly ? undefined : copy.sendTemplate}
                data-no-translate
                className={cn(
                  "h-8 gap-1.5 px-2 text-xs hover:bg-card hover:text-foreground",
                  sessionExpired ? "text-primary" : "text-muted-foreground",
                )}
                onClick={onOpenTemplates}
              >
                <LayoutTemplate className="h-4 w-4" />
                <span className="hidden sm:inline">{copy.templates}</span>
              </GatedButton>
            )}

            <span className="flex-1" />

            <GatedButton
              size="sm"
              canAct={!readOnly}
              gateReason="send messages"
              disabled={!text.trim() || textDisabled || sending}
              onClick={handleSend}
              data-no-translate
              aria-label={sendLabel}
              title={sendLabel}
              className={cn(
                "h-8 shrink-0 gap-1.5 px-3 text-xs font-medium disabled:opacity-40",
                isNote
                  ? "bg-amber-500 text-white hover:bg-amber-500/90"
                  : "bg-primary text-primary-foreground hover:bg-primary/90",
              )}
            >
              {sending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : isNote ? (
                <Lock className="h-4 w-4" />
              ) : (
                <Send className="h-4 w-4" />
              )}
              <span className="hidden sm:inline">{sendLabel}</span>
            </GatedButton>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Staged-attachment preview with caption + send/discard. Declared at
 * module scope (not nested in MessageComposer) so React keeps it mounted
 * across the parent's re-renders — a nested component would remount the
 * caption input on every keystroke and drop focus.
 */
function MediaDraftPreview({
  draft,
  busy,
  readOnly,
  onCaptionChange,
  onDiscard,
  onSend,
}: {
  draft: MediaDraft;
  busy: boolean;
  readOnly: boolean;
  onCaptionChange: (caption: string) => void;
  onDiscard: () => void;
  onSend: () => void;
}) {
  return (
    <div className="rounded-xl border border-border bg-muted/40 p-3">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          {draft.kind === "image" && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={draft.mediaUrl}
              alt={draft.filename}
              className="max-h-40 rounded-lg object-cover"
            />
          )}
          {draft.kind === "video" && (
            <video src={draft.mediaUrl} controls className="max-h-40 rounded-lg" />
          )}
          {draft.kind === "audio" && (
            <audio src={draft.mediaUrl} controls className="w-full" />
          )}
          {draft.kind === "document" && (
            <div className="flex items-center gap-2 text-sm text-foreground">
              <FileText className="h-5 w-5 shrink-0 text-muted-foreground" />
              <span className="truncate">{draft.filename}</span>
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={onDiscard}
          aria-label="Remove attachment"
          className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="mt-2 flex items-end gap-2">
        {draft.kind !== "audio" && (
          <input
            value={draft.caption}
            maxLength={MEDIA_CAPTION_MAX}
            onChange={(e) => onCaptionChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                onSend();
              }
            }}
            placeholder="Add a caption…"
            className="flex-1 rounded-xl border border-border bg-muted px-4 py-2.5 text-sm text-foreground placeholder-muted-foreground outline-none transition-colors focus:border-primary/50"
          />
        )}
        <GatedButton
          size="sm"
          canAct={!readOnly}
          gateReason="send messages"
          disabled={busy}
          onClick={onSend}
          className={cn(
            "h-9 w-9 shrink-0 bg-primary p-0 hover:bg-primary/90 disabled:opacity-40",
            draft.kind === "audio" && "ml-auto",
          )}
        >
          <Send className="h-4 w-4" />
        </GatedButton>
      </div>
    </div>
  );
}

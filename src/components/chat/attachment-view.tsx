"use client";

import { useState } from "react";
import { Download, FileText, Loader2, Mic } from "lucide-react";
import { toast } from "sonner";

import { cn } from "@/lib/utils";
import { useLanguage } from "@/hooks/use-language";
import { getSignedUrl, useSignedUrl } from "@/hooks/use-signed-url";
import { attachmentKind, formatBytes, formatDuration } from "@/lib/chat";
import type { ChatAttachment } from "@/types";

interface AttachmentViewProps {
  attachment: ChatAttachment;
  /** Own bubble (primary background) vs other (muted) — tunes the chip colours. */
  mine: boolean;
}

/** Open a 1-hour signed download link in a new tab. */
async function download(attachment: ChatAttachment, onError: () => void) {
  try {
    const url = await getSignedUrl(attachment.path, { download: attachment.name });
    window.open(url, "_blank", "noopener");
  } catch (err) {
    console.error("[chat] download:", err);
    onError();
  }
}

/**
 * Inline rendering for a message attachment: image / video preview,
 * audio player, or a document chip. URLs are signed client-side (1 h)
 * and cached per path in `useSignedUrl`.
 */
export function AttachmentView({ attachment, mine }: AttachmentViewProps) {
  const { t } = useLanguage();
  const kind = attachmentKind(attachment.mime);
  const { url, loading, error } = useSignedUrl(attachment.path);
  const [imgOpen, setImgOpen] = useState(false);
  const onDownloadError = () => toast.error(t("Could not load the attachment"));

  const chipClass = cn(
    "flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm transition-colors",
    mine ? "bg-primary-foreground/15 hover:bg-primary-foreground/25" : "bg-background/70 hover:bg-background",
  );
  const subtle = mine ? "text-primary-foreground/80" : "text-muted-foreground";

  if (error) {
    return (
      <div className={cn("rounded-lg px-2.5 py-2 text-xs", subtle)} role="alert">
        {t("Could not load the attachment")}
      </div>
    );
  }

  if (kind === "image") {
    const ratio = attachment.width && attachment.height ? attachment.width / attachment.height : undefined;
    return (
      <div className="w-64 max-w-full sm:w-72">
        <button
          type="button"
          onClick={() => url && setImgOpen(true)}
          className="block w-full overflow-hidden rounded-lg bg-background/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          style={ratio ? { aspectRatio: `${ratio}` } : undefined}
          aria-label={attachment.name}
          title={attachment.name}
        >
          {url ? (
            // eslint-disable-next-line @next/next/no-img-element -- signed, short-lived URL; next/image cannot optimise it
            <img src={url} alt={attachment.name} className="block h-auto w-full object-cover" loading="lazy" />
          ) : (
            <span className="flex h-40 items-center justify-center">
              <Loader2 className={cn("size-5 animate-spin", subtle)} />
            </span>
          )}
        </button>
        {imgOpen && url ? (
          <div
            role="dialog"
            aria-label={attachment.name}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
            onClick={() => setImgOpen(false)}
          >
            {/* eslint-disable-next-line @next/next/no-img-element -- lightbox of the signed URL */}
            <img src={url} alt={attachment.name} className="max-h-full max-w-full rounded-lg object-contain" />
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                void download(attachment, onDownloadError);
              }}
              className="absolute bottom-6 right-6 flex items-center gap-2 rounded-full bg-white/90 px-3 py-1.5 text-sm font-medium text-black shadow"
            >
              <Download className="size-4" />
              {t("Download")}
            </button>
          </div>
        ) : null}
      </div>
    );
  }

  if (kind === "video") {
    return (
      <div className="w-64 max-w-full sm:w-80">
        {url ? (
          <video src={url} controls preload="metadata" className="block w-full rounded-lg bg-black" title={attachment.name} />
        ) : (
          <span className="flex h-40 items-center justify-center rounded-lg bg-background/40">
            <Loader2 className={cn("size-5 animate-spin", subtle)} />
          </span>
        )}
        <p className={cn("mt-1 truncate text-[11px]", subtle)}>
          {attachment.name}
          {attachment.duration ? ` · ${formatDuration(attachment.duration)}` : ""} · {formatBytes(attachment.size)}
        </p>
      </div>
    );
  }

  if (kind === "audio") {
    return (
      <div className="flex w-64 max-w-full items-center gap-2 sm:w-72">
        <span className={cn("flex size-8 shrink-0 items-center justify-center rounded-full", mine ? "bg-primary-foreground/15" : "bg-background/70")}>
          <Mic className="size-4" />
        </span>
        {url ? (
          <audio src={url} controls preload="metadata" className="h-9 min-w-0 flex-1" title={attachment.name} />
        ) : (
          <span className="flex h-9 flex-1 items-center justify-center">
            <Loader2 className={cn("size-4 animate-spin", subtle)} />
          </span>
        )}
        {attachment.duration ? (
          <span className={cn("shrink-0 text-[11px] tabular-nums", subtle)}>{formatDuration(attachment.duration)}</span>
        ) : null}
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() => void download(attachment, onDownloadError)}
      disabled={loading}
      className={cn(chipClass, "w-64 max-w-full sm:w-72")}
      title={`${t("Download")} · ${attachment.name}`}
    >
      <span className={cn("flex size-9 shrink-0 items-center justify-center rounded-md", mine ? "bg-primary-foreground/15" : "bg-background")}>
        <FileText className="size-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{attachment.name}</span>
        <span className={cn("block text-[11px]", subtle)}>{formatBytes(attachment.size)}</span>
      </span>
      <Download className={cn("size-4 shrink-0", subtle)} aria-label={t("Download")} />
    </button>
  );
}

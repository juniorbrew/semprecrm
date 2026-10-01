"use client";

import { Loader2, MessageSquareText, X } from "lucide-react";

import type { AiStatus } from "@/hooks/use-ai-status";
import { cn } from "@/lib/utils";

/** Why "Sugerir resposta" can't be used right now (null = it can). */
export type SuggestReplyBlock =
  | "anonymized"
  | "read_only"
  | "expired"
  | "checking"
  | "module"
  | "disabled"
  | "no_key";

/**
 * Pure gate for the composer button. Order matters: the reasons the
 * agent can't do anything about (LGPD, role, 24h window) come before
 * the account-configuration ones.
 */
export function suggestReplyBlock(args: {
  status: AiStatus | null;
  contactAnonymized: boolean;
  sessionExpired: boolean;
  readOnly: boolean;
}): SuggestReplyBlock | null {
  if (args.contactAnonymized) return "anonymized";
  if (args.readOnly) return "read_only";
  // Cloud API outside the 24h window: only templates can be sent, so a
  // free-form suggestion would be useless.
  if (args.sessionExpired) return "expired";
  if (!args.status) return "checking";
  if (!args.status.available) return args.status.reason ?? "disabled";
  return null;
}

export interface SuggestReplyButtonProps {
  loading: boolean;
  /** Null when usable. */
  block: SuggestReplyBlock | null;
  /** Tooltip / aria text per state (already localised). */
  labels: {
    suggest: string;
    cancel: string;
    blocked: Record<SuggestReplyBlock, string>;
  };
  onSuggest: () => void;
  onCancel: () => void;
}

/**
 * One-line strip above the composer for a suggestion that arrived while
 * the box already had text: dashed primary-tinted border, the text
 * truncated, "Usar" (replace), "Adicionar ao final" and discard. No AI
 * icon (design principles). Copy comes in already localised.
 */
export function PendingSuggestionStrip({
  text,
  labels,
  onUse,
  onAppend,
  onDiscard,
}: {
  text: string;
  labels: { prefix: string; hint: string; use: string; append: string; discard: string };
  onUse: () => void;
  onAppend: () => void;
  onDiscard: () => void;
}) {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return (
    <div
      data-no-translate
      data-testid="pending-suggestion"
      role="status"
      title={labels.hint}
      className="mb-2 flex min-w-0 items-center gap-2 rounded-[var(--radius)] border border-dashed border-primary/55 px-3 py-1.5 text-xs text-muted-foreground"
    >
      <p className="min-w-0 flex-1 truncate">
        <span className="font-medium text-foreground">{labels.prefix}</span> “{oneLine}”
      </p>
      <button
        type="button"
        onClick={onUse}
        className="inline-flex h-7 shrink-0 items-center rounded-md border border-border bg-background px-2.5 font-medium text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {labels.use}
      </button>
      <button
        type="button"
        onClick={onAppend}
        className="hidden h-7 shrink-0 items-center rounded-md px-1.5 transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:inline-flex"
      >
        {labels.append}
      </button>
      <button
        type="button"
        onClick={onDiscard}
        aria-label={labels.discard}
        title={labels.discard}
        className="inline-flex size-7 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <X className="size-3.5" aria-hidden />
      </button>
    </div>
  );
}

/** Plain composer action: suggest → (spinner + ✕ to cancel) → idle. */
export function SuggestReplyButton({ loading, block, labels, onSuggest, onCancel }: SuggestReplyButtonProps) {
  const disabled = !loading && block !== null;
  const title = loading ? labels.cancel : block ? labels.blocked[block] : labels.suggest;
  return (
    <button
      type="button"
      data-testid="suggest-reply"
      data-no-translate
      disabled={disabled}
      aria-disabled={disabled || undefined}
      aria-busy={loading || undefined}
      aria-label={title}
      title={title}
      onMouseDown={(e) => e.preventDefault()}
      onClick={loading ? onCancel : onSuggest}
      className={cn(
        "group relative inline-flex h-8 items-center gap-1 rounded-md px-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50",
        loading && "bg-muted text-primary",
      )}
    >
      {loading ? (
        <>
          <Loader2 className="h-4 w-4 animate-spin group-hover:hidden" aria-hidden />
          <X className="hidden h-4 w-4 group-hover:block" aria-hidden />
        </>
      ) : (
        <MessageSquareText className="h-4 w-4" aria-hidden />
      )}
      <span className="hidden text-xs lg:inline">{loading ? labels.cancel : labels.suggest}</span>
    </button>
  );
}

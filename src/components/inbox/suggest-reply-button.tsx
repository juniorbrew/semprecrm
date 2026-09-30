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
        "group relative inline-flex h-8 items-center gap-1 rounded-md px-1.5 text-muted-foreground transition-colors hover:bg-card hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50",
        loading && "bg-card text-primary",
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

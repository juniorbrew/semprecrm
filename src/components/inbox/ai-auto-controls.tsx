"use client";

// Automatic reply in the inbox thread (AI phase 4, migration 066):
// "Pausar IA" / "Retomar IA" in the header and the hand-over card
// "Por que a IA passou para você". State comes from
// GET /api/conversations/:id/ai/auto and is refetched when the
// conversation's `ai_paused_until` changes (realtime row update).

import { useCallback, useEffect, useState } from "react";
import { Pause, Play, UserCheck } from "lucide-react";
import { toast } from "sonner";

import { useLanguage } from "@/hooks/use-language";

export interface AiHandoff {
  id: string;
  reason: string;
  customer_wants: string | null;
  last_customer_words: string | null;
  notified: boolean;
  created_at: string;
}

export interface AiAutoState {
  applies: boolean;
  agent: { id: string; name: string; paused: boolean } | null;
  paused: boolean;
  paused_until: string | null;
  handling: boolean;
  handoff: AiHandoff | null;
}

export function useAiAutoState(conversationId: string | undefined, refreshKey: string) {
  const [state, setState] = useState<{ id: string; value: AiAutoState } | null>(null);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (!conversationId) return;
    let cancelled = false;
    fetch(`/api/conversations/${conversationId}/ai/auto`)
      .then((r) => (r.ok ? (r.json() as Promise<AiAutoState>) : null))
      .then((value) => {
        if (!cancelled && value) setState({ id: conversationId, value });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [conversationId, refreshKey, version]);
  const reload = useCallback(() => setVersion((v) => v + 1), []);
  return { state: state && state.id === conversationId ? state.value : null, reload };
}

/** Header button (agent+). Shown only when an automatic agent answers this conversation. */
export function AiPauseButton({
  conversationId,
  state,
  canWrite,
  onChanged,
}: {
  conversationId: string;
  state: AiAutoState;
  canWrite: boolean;
  onChanged: () => void;
}) {
  const { t } = useLanguage();
  const [busy, setBusy] = useState(false);
  if (!state.applies) return null;
  const action = state.paused ? "resume" : "pause";
  const label = state.paused ? t("Resume AI") : t("Pause AI");

  async function run() {
    setBusy(true);
    try {
      const res = await fetch(`/api/conversations/${conversationId}/ai/auto`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) throw new Error(body?.error || "Could not change the AI for this conversation");
      toast.success(t(action === "pause" ? "AI paused in this conversation" : "AI resumed in this conversation"));
      onChanged();
    } catch (err) {
      toast.error(t(err instanceof Error ? err.message : "Could not change the AI for this conversation"));
    } finally {
      setBusy(false);
    }
  }

  const title = canWrite
    ? t(state.paused ? "The AI is not answering this conversation. Resume it." : "The AI is answering this conversation. Pause it.")
    : t("Read-only — your role can't change conversations");
  return (
    <button
      type="button"
      onClick={() => void run()}
      disabled={!canWrite || busy}
      title={title}
      aria-label={title}
      data-testid="ai-pause-toggle"
      className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-2 text-xs font-medium text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
    >
      {state.paused ? <Play className="h-3.5 w-3.5" aria-hidden /> : <Pause className="h-3.5 w-3.5" aria-hidden />}
      <span className="hidden @md:inline">{label}</span>
    </button>
  );
}

/** "Por que a IA passou para você" — above the composer while the hand-over holds. */
export function AiHandoffCard({
  handoff,
  canClaim,
  onClaim,
}: {
  handoff: AiHandoff;
  canClaim: boolean;
  onClaim: () => void;
}) {
  const { t } = useLanguage();
  return (
    <section
      aria-label={t("Why the AI handed this to you")}
      className="mx-3 mb-2 border-t border-border pt-3 text-sm sm:mx-4"
    >
      <h3 className="font-medium text-foreground">{t("Why the AI handed this to you")}</h3>
      <dl className="mt-2 grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
        {handoff.customer_wants && (
          <>
            <dt className="text-muted-foreground">{t("The customer wants")}</dt>
            <dd data-no-translate className="text-foreground">{handoff.customer_wants}</dd>
          </>
        )}
        {handoff.last_customer_words && (
          <>
            <dt className="text-muted-foreground">{t("Customer's last words")}</dt>
            <dd data-no-translate className="whitespace-pre-line text-foreground">“{handoff.last_customer_words}”</dd>
          </>
        )}
        <dt className="text-muted-foreground">{t("Reason")}</dt>
        <dd data-no-translate className="text-foreground">{handoff.reason}</dd>
        <dt className="text-muted-foreground">{t("Customer notified")}</dt>
        <dd className={handoff.notified ? "text-foreground" : "text-amber-700 dark:text-amber-300"}>
          {handoff.notified ? t("Yes") : t("No — the notice could not be sent")}
        </dd>
      </dl>
      {canClaim && (
        <button
          type="button"
          onClick={onClaim}
          className="mt-3 inline-flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground hover:bg-primary/90"
        >
          <UserCheck className="h-3.5 w-3.5" aria-hidden />
          {t("Take and reply")}
        </button>
      )}
    </section>
  );
}

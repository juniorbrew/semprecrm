"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { Check, Loader2, Pencil, Sparkles, Trash2, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useAiStatus } from "@/hooks/use-ai-status";
import { useCan } from "@/hooks/use-can";
import { useLanguage } from "@/hooks/use-language";
import { MEMORY_LIMITS, type ContactMemory } from "@/lib/ai/memory";

interface ContactMemorySectionProps {
  contactId: string;
  /** Thread the "Extrair fatos" button reads. */
  conversationId: string | null;
  anonymized: boolean;
  /** The panel's SectionHeader, with this section's action and count. */
  renderHeader: (action: ReactNode, count: number) => ReactNode;
  /** The panel's small "+" button. */
  renderAddButton: (label: string, onClick: () => void) => ReactNode;
}

/** Start of the conversation a proposed fact came from. */
function sourceDate(m: ContactMemory): string | null {
  const c = Array.isArray(m.conversation) ? m.conversation[0] : m.conversation;
  return c?.created_at ?? null;
}

async function errorKey(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  return body?.error ?? "";
}

/**
 * "Memória do contato" (migration 064) in the inbox contact panel.
 * Active facts go into AI suggestions; facts the AI proposes wait here
 * for an agent to approve, edit or reject. Viewers read only.
 */
export function ContactMemorySection({
  contactId,
  conversationId,
  anonymized,
  renderHeader,
  renderAddButton,
}: ContactMemorySectionProps) {
  const { t, language } = useLanguage();
  const canWrite = useCan("send-messages") && !anonymized;
  const aiStatus = useAiStatus();
  const [items, setItems] = useState<{ contactId: string; list: ContactMemory[] } | null>(null);
  const [draft, setDraft] = useState<{ id: string | null; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const list = items?.contactId === contactId ? items.list : null;
  const setList = useCallback(
    (fn: (prev: ContactMemory[]) => ContactMemory[]) =>
      setItems((prev) => (prev && prev.contactId === contactId ? { contactId, list: fn(prev.list) } : prev)),
    [contactId],
  );

  useEffect(() => {
    let alive = true;
    setDraft(null);
    void fetch(`/api/contacts/${contactId}/ai/memories`, { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : { memories: [] }))
      .then((body: { memories?: ContactMemory[] }) => {
        if (alive) setItems({ contactId, list: body.memories ?? [] });
      })
      .catch(() => {
        if (alive) setItems({ contactId, list: [] });
      });
    return () => {
      alive = false;
    };
  }, [contactId]);

  const fail = (key: string, fallback: string) => toast.error(key ? t(key) : t(fallback));

  async function extract() {
    if (!conversationId) return;
    setBusy("extract");
    try {
      const res = await fetch(`/api/conversations/${conversationId}/ai/memory`, { method: "POST" });
      if (!res.ok) return fail(await errorKey(res), "Could not extract facts");
      const { created } = (await res.json()) as { created: ContactMemory[] };
      setList((prev) => [...created, ...prev]);
      toast.success(created.length ? t("New facts to review") : t("No new facts found in this conversation"));
    } catch {
      fail("", "Could not extract facts");
    } finally {
      setBusy(null);
    }
  }

  async function saveDraft() {
    if (!draft?.text.trim()) return;
    setBusy(draft.id ?? "add");
    try {
      const res = draft.id
        ? await fetch(`/api/contacts/${contactId}/ai/memories/${draft.id}`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ fact: draft.text }),
          })
        : await fetch(`/api/contacts/${contactId}/ai/memories`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ fact: draft.text }),
          });
      if (!res.ok) return fail(await errorKey(res), "Could not save the fact");
      const { memory } = (await res.json()) as { memory: ContactMemory };
      setList((prev) => (draft.id ? prev.map((m) => (m.id === memory.id ? memory : m)) : [memory, ...prev]));
      setDraft(null);
    } catch {
      fail("", "Could not save the fact");
    } finally {
      setBusy(null);
    }
  }

  async function setStatus(m: ContactMemory, status: "active" | "rejected") {
    setBusy(m.id);
    try {
      const res = await fetch(`/api/contacts/${contactId}/ai/memories/${m.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status }),
      });
      if (!res.ok) return fail(await errorKey(res), "Could not save the fact");
      const { memory } = (await res.json()) as { memory: ContactMemory };
      setList((prev) => (status === "rejected" ? prev.filter((x) => x.id !== m.id) : prev.map((x) => (x.id === m.id ? memory : x))));
    } catch {
      fail("", "Could not save the fact");
    } finally {
      setBusy(null);
    }
  }

  async function remove(m: ContactMemory) {
    setBusy(m.id);
    try {
      const res = await fetch(`/api/contacts/${contactId}/ai/memories/${m.id}`, { method: "DELETE" });
      if (!res.ok) return fail(await errorKey(res), "Could not delete the fact");
      setList((prev) => prev.filter((x) => x.id !== m.id));
    } catch {
      fail("", "Could not delete the fact");
    } finally {
      setBusy(null);
    }
  }

  const proposed = (list ?? []).filter((m) => m.status === "proposed");
  const active = (list ?? []).filter((m) => m.status === "active");

  const editor = (id: string | null) => (
    <div className="space-y-1.5">
      <Textarea
        autoFocus
        value={draft?.text ?? ""}
        maxLength={MEMORY_LIMITS.factMaxChars}
        rows={2}
        onChange={(e) => setDraft((d) => (d ? { ...d, text: e.target.value } : d))}
        onKeyDown={(e) => {
          if (e.key === "Escape") setDraft(null);
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) void saveDraft();
        }}
        placeholder={t("E.g.: Prefers delivery in the afternoon")}
        aria-label={t("Fact about the contact")}
        className="min-h-0 bg-card text-xs"
      />
      <div className="flex justify-end gap-1.5">
        <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setDraft(null)}>
          {t("Cancel")}
        </Button>
        <Button size="sm" className="h-7 text-xs" disabled={!draft?.text.trim() || busy === (id ?? "add")} onClick={() => void saveDraft()}>
          {busy === (id ?? "add") ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : null}
          {t("Save")}
        </Button>
      </div>
    </div>
  );

  const iconButton = (label: string, onClick: () => void, icon: ReactNode, disabled: boolean, danger = false) => (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={
        danger
          ? "inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
          : "inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
      }
    >
      {icon}
    </button>
  );

  return (
    <div>
      {renderHeader(canWrite ? renderAddButton(t("Add fact"), () => setDraft({ id: null, text: "" })) : null, active.length)}
      <div className="mt-2 space-y-2 px-1">
        {draft && draft.id === null && editor(null)}

        {list === null ? (
          <div className="h-8 animate-pulse rounded-lg bg-muted/60" />
        ) : proposed.length === 0 && active.length === 0 && !draft ? (
          <p className="rounded-lg border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
            {t("No facts saved yet. Approved facts are used in AI suggestions.")}
          </p>
        ) : null}

        {proposed.map((m) => (
          <div key={m.id} className="rounded-lg border border-dashed border-primary/40 bg-primary/5 px-3 py-2">
            {draft?.id === m.id ? (
              editor(m.id)
            ) : (
              <>
                <p className="whitespace-pre-wrap text-xs text-foreground" data-no-translate>
                  {m.fact}
                </p>
                <div className="mt-1 flex items-center justify-between gap-2">
                  <span className="inline-flex items-center gap-1 text-[10px] text-primary">
                    <Sparkles className="h-2.5 w-2.5" aria-hidden />
                    {t("Suggested by AI — review")}
                    {sourceDate(m) ? (
                      <span className="text-muted-foreground" data-no-translate>
                        · {t("conversation of")} {new Date(sourceDate(m)!).toLocaleDateString(language)}
                      </span>
                    ) : null}
                  </span>
                  {canWrite && (
                    <span className="flex items-center">
                      {iconButton(t("Approve"), () => void setStatus(m, "active"), <Check className="h-3.5 w-3.5" />, busy === m.id)}
                      {iconButton(t("Edit"), () => setDraft({ id: m.id, text: m.fact }), <Pencil className="h-3 w-3" />, busy === m.id)}
                      {iconButton(t("Reject"), () => void setStatus(m, "rejected"), <X className="h-3.5 w-3.5" />, busy === m.id, true)}
                    </span>
                  )}
                </div>
              </>
            )}
          </div>
        ))}

        {active.map((m) => (
          <div key={m.id} className="group rounded-lg border border-border bg-card px-3 py-2">
            {draft?.id === m.id ? (
              editor(m.id)
            ) : (
              <div className="flex items-start gap-2">
                <p className="min-w-0 flex-1 whitespace-pre-wrap text-xs text-foreground" data-no-translate>
                  {m.fact}
                </p>
                {canWrite && (
                  <span className="flex shrink-0 items-center opacity-100 transition-opacity sm:opacity-0 sm:group-focus-within:opacity-100 sm:group-hover:opacity-100">
                    {iconButton(t("Edit"), () => setDraft({ id: m.id, text: m.fact }), <Pencil className="h-3 w-3" />, busy === m.id)}
                    {iconButton(t("Delete"), () => void remove(m), <Trash2 className="h-3 w-3" />, busy === m.id, true)}
                  </span>
                )}
              </div>
            )}
          </div>
        ))}

        {canWrite && conversationId && aiStatus?.available && (
          <Button
            size="sm"
            variant="outline"
            className="h-7 w-full text-xs"
            disabled={busy === "extract"}
            onClick={() => void extract()}
            title={t("Reads this conversation and proposes facts for you to review. Uses the AI budget.")}
          >
            {busy === "extract" ? (
              <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />
            ) : (
              <Sparkles className="mr-1.5 h-3 w-3" />
            )}
            {busy === "extract" ? t("Extracting…") : t("Extract facts")}
          </Button>
        )}
      </div>
    </div>
  );
}

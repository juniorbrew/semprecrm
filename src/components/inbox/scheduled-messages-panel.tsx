"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, CalendarClock, Loader2, Pencil, Send, X } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import type { Language } from "@/lib/i18n";
import {
  formatScheduledAt,
  parseLocalInput,
  toLocalInputValue,
  validateScheduleAt,
} from "@/lib/scheduled-messages/schedule";
import { SCHEDULED_COPY } from "./scheduled-copy";

export interface ScheduledItem {
  id: string;
  created_by: string;
  content_text: string;
  scheduled_for: string;
  status: "pending" | "sending" | "failed";
  error_text: string | null;
}

interface ScheduledMessagesPanelProps {
  conversationId: string;
  language: Language;
  /** Agent+ (viewers see the list but cannot touch it). */
  canAct: boolean;
  profiles: { user_id: string; full_name?: string | null }[];
  /** Bump to refetch (after the composer scheduled something). */
  refreshKey: number;
  /** Cancel hands the text back to the composer. */
  onRestoreText: (text: string) => void;
  now?: () => Date;
}

const POLL_MS = 30_000;

async function call(url: string, init?: RequestInit): Promise<Record<string, unknown>> {
  const res = await fetch(url, init);
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error(typeof body.error === "string" ? body.error : "request failed");
  return body;
}

/** Pending scheduled messages of the open conversation, until they are sent. */
export function ScheduledMessagesPanel({
  conversationId,
  language,
  canAct,
  profiles,
  refreshKey,
  onRestoreText,
  now = () => new Date(),
}: ScheduledMessagesPanelProps) {
  const copy = SCHEDULED_COPY[language] ?? SCHEDULED_COPY["pt-BR"];
  const [items, setItems] = useState<ScheduledItem[]>([]);
  const [windowEnds, setWindowEnds] = useState<number | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string; text: string; when: string; error: string | null } | null>(null);

  const load = useCallback(async () => {
    try {
      const body = await call(`/api/inbox/scheduled?conversation_id=${encodeURIComponent(conversationId)}`);
      setItems((body.items as ScheduledItem[]) ?? []);
      setWindowEnds(typeof body.window_ends_at === "string" ? new Date(body.window_ends_at).getTime() : null);
    } catch {
      /* keep what is on screen; the next poll retries */
    }
  }, [conversationId]);

  useEffect(() => {
    setItems([]);
    setEditing(null);
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    const onVisible = () => document.visibilityState === "visible" && void load();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [load, refreshKey]);

  async function run(id: string, fn: () => Promise<void>) {
    setBusyId(id);
    try {
      await fn();
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : copy.genericError);
    } finally {
      setBusyId(null);
      void load();
    }
  }

  const cancel = (item: ScheduledItem) =>
    run(item.id, async () => {
      const body = await call(`/api/inbox/scheduled/${item.id}`, { method: "DELETE" });
      const text = typeof body.content_text === "string" ? body.content_text : item.content_text;
      onRestoreText(text);
      toast.success(copy.cancelledRestored);
    });

  const sendNow = (item: ScheduledItem) =>
    run(item.id, async () => {
      await call(`/api/inbox/scheduled/${item.id}/send`, { method: "POST" });
      toast.success(copy.sentNow);
    });

  const saveEdit = () => {
    if (!editing) return;
    const at = parseLocalInput(editing.when);
    const check = validateScheduleAt(at, now());
    if (!check.ok) {
      setEditing({ ...editing, error: copy.errors[check.code] });
      return;
    }
    const { id, text } = editing;
    void run(id, async () => {
      await call(`/api/inbox/scheduled/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content_text: text, scheduled_for: check.date.toISOString() }),
      });
      setEditing(null);
    });
  };

  if (items.length === 0) return null;
  const clock = now();
  const nameOf = (uid: string) => profiles.find((p) => p.user_id === uid)?.full_name || "—";

  return (
    <section
      data-testid="scheduled-panel"
      data-no-translate
      aria-label={copy.panelTitle(items.length)}
      className="border-t border-border bg-muted/30 px-4 py-2"
    >
      <h3 className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <CalendarClock className="h-3.5 w-3.5" aria-hidden />
        {copy.panelTitle(items.length)}
      </h3>
      <ul className="flex max-h-48 flex-col gap-1.5 overflow-y-auto">
        {items.map((item) => {
          const at = new Date(item.scheduled_for);
          const failed = item.status === "failed";
          const sending = item.status === "sending";
          const risk = !failed && windowEnds !== null && at.getTime() >= windowEnds;
          const busy = busyId === item.id;
          const isEditing = editing?.id === item.id;
          return (
            <li
              key={item.id}
              data-status={item.status}
              className={
                failed
                  ? "rounded-md border border-destructive/40 bg-destructive/5 p-2"
                  : "rounded-md border border-dashed border-border bg-card p-2"
              }
            >
              {isEditing && editing ? (
                <div className="flex flex-col gap-1.5">
                  <textarea
                    aria-label={copy.edit}
                    value={editing.text}
                    maxLength={4096}
                    rows={3}
                    onChange={(e) => setEditing({ ...editing, text: e.target.value })}
                    className="w-full resize-y rounded-md border border-input bg-background p-2 text-sm outline-none focus:border-primary/60"
                  />
                  <input
                    type="datetime-local"
                    aria-label={copy.custom}
                    value={editing.when}
                    onChange={(e) => setEditing({ ...editing, when: e.target.value, error: null })}
                    className="h-8 w-full rounded-md border border-input bg-background px-2 text-sm outline-none focus:border-primary/60"
                  />
                  {editing.error && (
                    <p role="alert" className="text-xs text-destructive">
                      {editing.error}
                    </p>
                  )}
                  <div className="flex gap-2">
                    <Button size="sm" disabled={busy || !editing.text.trim()} onClick={saveEdit}>
                      {busy && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
                      {copy.save}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
                      {copy.cancelEdit}
                    </Button>
                  </div>
                </div>
              ) : (
                <>
                  <p className="line-clamp-3 whitespace-pre-wrap break-words text-sm">{item.content_text}</p>
                  <p className="mt-1 flex flex-wrap items-center gap-x-2 text-[11px] text-muted-foreground">
                    <span className={failed ? "font-medium text-destructive" : undefined}>
                      {failed ? copy.failed : sending ? copy.sending : copy.sendsAt(formatScheduledAt(at, clock, language))}
                    </span>
                    <span>{copy.by(nameOf(item.created_by))}</span>
                    {failed && <span>· {formatScheduledAt(at, clock, language)}</span>}
                  </p>
                  {failed && item.error_text && (
                    <p role="alert" className="mt-1 text-xs text-destructive">
                      {item.error_text}
                    </p>
                  )}
                  {risk && (
                    <p className="mt-1 flex items-start gap-1 text-xs text-amber-700 dark:text-amber-400">
                      <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
                      {copy.windowRisk}
                    </p>
                  )}
                  {canAct && !sending && (
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      <Button size="xs" variant="outline" disabled={busy} onClick={() => void sendNow(item)}>
                        {busy ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <Send className="mr-1 h-3 w-3" />}
                        {failed ? copy.retry : copy.sendNow}
                      </Button>
                      <Button
                        size="xs"
                        variant="ghost"
                        disabled={busy}
                        onClick={() =>
                          setEditing({
                            id: item.id,
                            text: item.content_text,
                            when: toLocalInputValue(at.getTime() > clock.getTime() ? at : new Date(clock.getTime() + 3_600_000)),
                            error: null,
                          })
                        }
                      >
                        <Pencil className="mr-1 h-3 w-3" />
                        {copy.edit}
                      </Button>
                      <Button size="xs" variant="ghost" disabled={busy} onClick={() => void cancel(item)}>
                        <X className="mr-1 h-3 w-3" />
                        {copy.cancel}
                      </Button>
                    </div>
                  )}
                </>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

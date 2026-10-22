"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { CalendarClock, Loader2, Send } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useAuth } from "@/hooks/use-auth";
import { useCan } from "@/hooks/use-can";
import { useLanguage } from "@/hooks/use-language";
import { hasMinRole } from "@/lib/auth/roles";
import { formatScheduledAt } from "@/lib/scheduled-messages/schedule";
import { cn } from "@/lib/utils";
import { SCHEDULED_COPY } from "./scheduled-copy";
import { MAYBE_SENT, call, canManageItem, sendScheduled, type ScheduledItem } from "./scheduled-api";

const POLL_MS = 60_000;

/** Counts for the header badge: everything open, and what needs attention. */
export function scheduledCounts(items: Pick<ScheduledItem, "status">[]) {
  return { open: items.length, failed: items.filter((i) => i.status === "failed").length };
}

interface ScheduledOverviewProps {
  /** Opens the conversation the message belongs to. */
  onOpenConversation: (conversationId: string) => void;
  now?: () => Date;
}

/**
 * Account-wide "Agendadas": every open scheduled message (pending + failed),
 * reachable from the inbox header, with a red badge when something failed.
 */
export function ScheduledOverview({ onOpenConversation, now = () => new Date() }: ScheduledOverviewProps) {
  const { language } = useLanguage();
  const copy = SCHEDULED_COPY[language] ?? SCHEDULED_COPY["pt-BR"];
  const { user, accountRole } = useAuth();
  const canAct = useCan("send-messages");
  const isAdmin = !!accountRole && hasMinRole(accountRole, "admin");

  const [items, setItems] = useState<ScheduledItem[]>([]);
  const [open, setOpen] = useState(false);
  const [mine, setMine] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const body = await call("/api/inbox/scheduled");
      setItems((body.items as ScheduledItem[]) ?? []);
    } catch {
      /* keep what is shown; the next poll retries */
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    const onVisible = () => document.visibilityState === "visible" && void load();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [load]);

  // Refetch whenever the dialog opens so the list is never stale.
  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  const { open: openCount, failed } = scheduledCounts(items);
  const shown = useMemo(
    () => (mine ? items.filter((i) => i.created_by === user?.id) : items),
    [items, mine, user?.id],
  );
  const clock = now();

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

  // Nothing scheduled and nothing to see: no clutter in the header.
  if (openCount === 0 && !open) return null;

  return (
    <>
      <button
        type="button"
        data-testid="scheduled-overview-button"
        data-no-translate
        onClick={() => setOpen(true)}
        aria-label={copy.overviewBadge(openCount, failed)}
        title={copy.overviewBadge(openCount, failed)}
        className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <CalendarClock className="h-3.5 w-3.5" aria-hidden />
        <span className="tabular-nums">{openCount}</span>
        {failed > 0 && (
          <span
            data-testid="scheduled-failed-badge"
            className="rounded-full bg-destructive px-1.5 text-[10px] font-semibold leading-4 text-white tabular-nums"
          >
            {failed}
          </span>
        )}
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent data-no-translate className="max-w-xl">
          <DialogHeader>
            <DialogTitle>{copy.overviewTitle}</DialogTitle>
          </DialogHeader>
          <div className="flex gap-1" role="tablist">
            {[
              { v: false, label: copy.filterAll },
              { v: true, label: copy.filterMine },
            ].map((f) => (
              <button
                key={String(f.v)}
                type="button"
                role="tab"
                aria-selected={mine === f.v}
                onClick={() => setMine(f.v)}
                className={cn(
                  "h-7 rounded-full px-3 text-xs",
                  mine === f.v ? "bg-primary/15 font-semibold text-primary" : "text-muted-foreground hover:bg-muted",
                )}
              >
                {f.label}
              </button>
            ))}
          </div>
          {shown.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">{copy.overviewEmpty}</p>
          ) : (
            <ul className="flex max-h-[60vh] flex-col gap-1.5 overflow-y-auto">
              {shown.map((item) => {
                const at = new Date(item.scheduled_for);
                const isFailed = item.status === "failed";
                const manageable = canAct && canManageItem(item, user?.id, isAdmin);
                const busy = busyId === item.id;
                return (
                  <li
                    key={item.id}
                    data-status={item.status}
                    className={cn(
                      "rounded-md border p-2",
                      isFailed ? "border-destructive/40 bg-destructive/5" : "border-border bg-card",
                    )}
                  >
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="truncate text-sm font-medium">{item.contact_name || copy.unknownContact}</span>
                      <span
                        className={cn(
                          "shrink-0 text-[11px]",
                          isFailed ? "font-medium text-destructive" : "text-muted-foreground",
                        )}
                      >
                        {item.error_code === MAYBE_SENT
                          ? copy.maybeSent
                          : isFailed
                            ? copy.failed
                            : item.status === "sending"
                              ? copy.sending
                              : formatScheduledAt(at, clock, language)}
                      </span>
                    </div>
                    <p className="line-clamp-2 whitespace-pre-wrap break-words text-sm text-muted-foreground">
                      {item.content_text}
                    </p>
                    {isFailed && item.error_text && (
                      <p className="mt-1 text-xs text-destructive">{item.error_text}</p>
                    )}
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      <Button
                        size="xs"
                        variant="outline"
                        onClick={() => {
                          onOpenConversation(item.conversation_id);
                          setOpen(false);
                        }}
                      >
                        {copy.openConversation}
                      </Button>
                      {manageable && item.status !== "sending" && (
                        <>
                          <Button
                            size="xs"
                            variant="ghost"
                            disabled={busy}
                            onClick={() =>
                              void run(item.id, async () => {
                                if (await sendScheduled(item, language)) toast.success(copy.sentNow);
                              })
                            }
                          >
                            {busy ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <Send className="mr-1 h-3 w-3" />}
                            {isFailed ? copy.retry : copy.sendNow}
                          </Button>
                        </>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

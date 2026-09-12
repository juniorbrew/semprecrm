'use client';

import { useEffect, useState, useMemo, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { Broadcast } from '@/types';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Radio,
  Plus,
  Loader2,
  ChevronRight,
  MoreHorizontal,
  Eye,
  Trash2,
  CalendarClock,
} from 'lucide-react';
import { toast } from 'sonner';
import { useCan } from '@/hooks/use-can';
import { useLanguage } from '@/hooks/use-language';
import { GatedButton } from '@/components/ui/gated-button';
import { getBroadcastStatus } from '@/lib/broadcast-status';

/**
 * Poll cadence while any broadcast is sending. Kept modest so we don't
 * beat on Supabase — the aggregate trigger in migration 003 keeps
 * counts consistent; we just need to surface the freshest snapshot.
 */
const POLL_INTERVAL_MS = 5_000;

function percent(numerator: number, denominator: number): number {
  if (!denominator) return 0;
  return Math.round((numerator / denominator) * 100);
}

function RateCell({
  value,
  total,
  color,
}: {
  value: number;
  total: number;
  /** Tailwind bg class for the fill, e.g. "bg-primary" */
  color: string;
}) {
  const pct = percent(value, total);
  return (
    <div className="flex items-center gap-2">
      <span className="w-10 text-right text-xs tabular-nums text-muted-foreground">
        {pct}%
      </span>
      <div className="h-1.5 w-16 overflow-hidden rounded-full bg-muted">
        <div
          className={`h-1.5 rounded-full ${color}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

/** Placeholder for cells that have nothing meaningful to show yet. */
function EmptyCell() {
  return <span className="text-muted-foreground/60">—</span>;
}

export default function BroadcastsPage() {
  const router = useRouter();
  const { t, language } = useLanguage();
  const canCreate = useCan('send-messages');
  const [broadcasts, setBroadcasts] = useState<Broadcast[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Broadcast | null>(null);
  const [deleting, setDeleting] = useState(false);

  // Used to kick off polling only while something is actively sending.
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  async function fetchBroadcasts() {
    try {
      const supabase = createClient();
      const { data, error: fetchError } = await supabase
        .from('broadcasts')
        .select('*')
        .order('created_at', { ascending: false });

      if (fetchError) throw fetchError;
      setBroadcasts(data ?? []);
    } catch (err) {
      // English key — translated where it is rendered.
      setError(err instanceof Error ? err.message : 'Failed to load broadcasts');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchBroadcasts();
  }, []);

  const anySending = useMemo(
    () => broadcasts.some((b) => b.status === 'sending'),
    [broadcasts],
  );

  useEffect(() => {
    function startPolling() {
      if (pollTimer.current) return;
      pollTimer.current = setInterval(fetchBroadcasts, POLL_INTERVAL_MS);
    }
    function stopPolling() {
      if (!pollTimer.current) return;
      clearInterval(pollTimer.current);
      pollTimer.current = null;
    }

    // Pause polling while the tab is hidden — keeps Supabase cold when
    // the user is away, and ensures a fresh fetch the moment they
    // refocus so they don't see stale data on return.
    function handleVisibilityChange() {
      if (!anySending) return;
      if (document.visibilityState === 'hidden') {
        stopPolling();
      } else {
        fetchBroadcasts();
        startPolling();
      }
    }

    if (anySending && document.visibilityState === 'visible') {
      startPolling();
    } else {
      stopPolling();
    }
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      stopPolling();
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [anySending]);

  async function handleDelete() {
    if (!pendingDelete) return;
    setDeleting(true);
    const supabase = createClient();
    // broadcast_recipients cascades on broadcasts.id (migration 001), so
    // a single delete is sufficient — same rule as the detail page.
    const { error: delErr } = await supabase
      .from('broadcasts')
      .delete()
      .eq('id', pendingDelete.id);
    setDeleting(false);
    if (delErr) {
      toast.error(`${t('Failed to delete')}: ${delErr.message}`);
      return;
    }
    setBroadcasts((prev) => prev.filter((b) => b.id !== pendingDelete.id));
    setPendingDelete(null);
    toast.success(t('Broadcast deleted'));
  }

  function formatDate(iso: string) {
    return new Date(iso).toLocaleDateString(language);
  }

  function formatDateTime(iso: string) {
    return new Date(iso).toLocaleString(language, {
      dateStyle: 'short',
      timeStyle: 'short',
    });
  }

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-64 flex-col items-center justify-center gap-2">
        <p className="text-sm text-red-400">{t(error)}</p>
        <Button variant="outline" onClick={() => window.location.reload()}>
          {t('Try again')}
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Top indeterminate progress bar: only visible while a broadcast
          is mid-send. Pure CSS animation so no extra deps. */}
      {anySending && (
        <div
          role="progressbar"
          aria-label={t('Broadcast in progress')}
          className="broadcast-indeterminate fixed inset-x-0 top-0 z-40 h-0.5 overflow-hidden bg-muted"
        >
          <div className="broadcast-indeterminate-bar h-0.5 bg-primary" />
          <style jsx>{`
            .broadcast-indeterminate-bar {
              width: 33%;
              transform: translateX(-100%);
              animation: broadcast-slide 1.6s cubic-bezier(0.4, 0, 0.2, 1)
                infinite;
            }
            @keyframes broadcast-slide {
              0% {
                transform: translateX(-100%);
              }
              100% {
                transform: translateX(400%);
              }
            }
          `}</style>
        </div>
      )}

      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">{t('Broadcasts')}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t('Send bulk messages to your contacts using approved templates.')}
          </p>
        </div>
        <GatedButton
          canAct={canCreate}
          gateReason="create broadcasts"
          onClick={() => router.push('/broadcasts/new')}
          className="bg-primary text-primary-foreground hover:bg-primary/90"
        >
          <Plus className="h-4 w-4" />
          {t('New Broadcast')}
        </GatedButton>
      </div>

      {broadcasts.length === 0 ? (
        <div className="flex h-64 flex-col items-center justify-center rounded-xl border border-border bg-card">
          <Radio className="mb-3 h-10 w-10 text-muted-foreground" />
          <p className="text-sm font-medium text-foreground">{t('No broadcasts yet')}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {t('Create your first broadcast to reach your contacts at scale.')}
          </p>
          <GatedButton
            canAct={canCreate}
            gateReason="create broadcasts"
            onClick={() => router.push('/broadcasts/new')}
            className="mt-4 bg-primary text-primary-foreground hover:bg-primary/90"
          >
            <Plus className="h-4 w-4" />
            {t('New Broadcast')}
          </GatedButton>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border bg-card">
          <Table>
            <TableHeader>
              <TableRow className="border-border hover:bg-transparent">
                <TableHead className="text-muted-foreground">{t('Name')}</TableHead>
                <TableHead className="hidden text-muted-foreground xl:table-cell">
                  {t('Template')}
                </TableHead>
                <TableHead className="hidden text-right text-muted-foreground sm:table-cell">
                  {t('Recipients')}
                </TableHead>
                <TableHead className="hidden text-muted-foreground lg:table-cell">
                  {t('Delivery')}
                </TableHead>
                <TableHead className="hidden text-muted-foreground lg:table-cell">
                  {t('Read')}
                </TableHead>
                <TableHead className="text-muted-foreground">{t('Status')}</TableHead>
                <TableHead className="hidden text-muted-foreground xl:table-cell">
                  {t('Date')}
                </TableHead>
                <TableHead className="w-20 text-right text-muted-foreground">
                  <span className="sr-only">{t('Actions')}</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {broadcasts.map((broadcast) => {
                const status = getBroadcastStatus(broadcast.status);
                const isDraft = broadcast.status === 'draft';
                const isScheduled = broadcast.status === 'scheduled';
                // Drafts and scheduled sends have no delivery data yet —
                // an empty 0% bar reads like a failure, so show what the
                // user actually wants to know (when it goes out) instead.
                const hasProgress = !isDraft && !isScheduled;
                const open = () => router.push(`/broadcasts/${broadcast.id}`);
                return (
                  <TableRow
                    key={broadcast.id}
                    tabIndex={0}
                    onClick={open}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') open();
                    }}
                    className="group cursor-pointer border-border transition-colors hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none"
                  >
                    <TableCell className="min-w-[10rem] max-w-xs whitespace-normal font-medium text-foreground transition-colors group-hover:text-primary">
                      {broadcast.name}
                    </TableCell>
                    <TableCell className="hidden text-muted-foreground xl:table-cell">
                      <span
                        className="block max-w-[11rem] truncate"
                        title={broadcast.template_name}
                      >
                        {broadcast.template_name}
                      </span>
                    </TableCell>
                    <TableCell className="hidden text-right text-muted-foreground tabular-nums sm:table-cell">
                      {isDraft && broadcast.total_recipients === 0 ? (
                        <EmptyCell />
                      ) : (
                        broadcast.total_recipients
                      )}
                    </TableCell>
                    <TableCell className="hidden lg:table-cell">
                      {hasProgress ? (
                        <RateCell
                          value={broadcast.delivered_count}
                          total={broadcast.total_recipients}
                          color="bg-primary"
                        />
                      ) : isScheduled && broadcast.scheduled_at ? (
                        <span className="inline-flex max-w-[11rem] items-start gap-1.5 whitespace-normal text-xs leading-snug text-muted-foreground">
                          <CalendarClock className="mt-0.5 h-3.5 w-3.5 shrink-0 text-blue-400" />
                          <span>
                            {t('Scheduled for')}
                            <br />
                            <span className="text-foreground">
                              {formatDateTime(broadcast.scheduled_at)}
                            </span>
                          </span>
                        </span>
                      ) : (
                        <span className="text-xs text-muted-foreground/70">
                          {t('Not sent yet')}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="hidden lg:table-cell">
                      {hasProgress ? (
                        <RateCell
                          value={broadcast.read_count}
                          total={broadcast.total_recipients}
                          color="bg-blue-500"
                        />
                      ) : (
                        <EmptyCell />
                      )}
                    </TableCell>
                    <TableCell>
                      <span
                        className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium ${status.classes}`}
                      >
                        {status.pulse && (
                          <span className="relative flex h-1.5 w-1.5">
                            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-yellow-400 opacity-75" />
                            <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-yellow-400" />
                          </span>
                        )}
                        {t(status.label)}
                      </span>
                    </TableCell>
                    <TableCell className="hidden text-muted-foreground xl:table-cell">
                      {formatDate(broadcast.created_at)}
                    </TableCell>
                    {/* Row actions — the cell swallows clicks so the menu
                        (and its portal, which bubbles through React) never
                        triggers the row navigation. */}
                    <TableCell
                      className="text-right"
                      onClick={(e) => e.stopPropagation()}
                      onKeyDown={(e) => e.stopPropagation()}
                    >
                      <div className="flex items-center justify-end gap-1">
                        <DropdownMenu>
                          <DropdownMenuTrigger
                            render={
                              <Button
                                variant="ghost"
                                size="icon"
                                aria-label={t('Broadcast actions')}
                                className="h-7 w-7 text-muted-foreground hover:text-foreground"
                              />
                            }
                          >
                            <MoreHorizontal className="h-4 w-4" />
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="border-border bg-popover">
                            <DropdownMenuItem onClick={open}>
                              <Eye className="h-4 w-4" />
                              {t('View details')}
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              variant="destructive"
                              disabled={broadcast.status === 'sending'}
                              onClick={() => setPendingDelete(broadcast)}
                            >
                              <Trash2 className="h-4 w-4" />
                              {t('Delete')}
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                        <ChevronRight
                          aria-hidden="true"
                          className="h-4 w-4 text-muted-foreground/50 transition-colors group-hover:text-primary"
                        />
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      <Dialog
        open={pendingDelete !== null}
        onOpenChange={(isOpen) => {
          if (!isOpen && !deleting) setPendingDelete(null);
        }}
      >
        <DialogContent className="border-border bg-popover sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-popover-foreground">
              {t('Delete broadcast')}
            </DialogTitle>
            <DialogDescription className="text-muted-foreground">
              <span className="font-medium text-popover-foreground">
                {pendingDelete?.name}
              </span>
              {' — '}
              {t(
                'This will permanently delete the broadcast and its recipient report. This action cannot be undone.',
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setPendingDelete(null)}
              disabled={deleting}
              className="border-border text-muted-foreground"
            >
              {t('Cancel')}
            </Button>
            <Button
              onClick={handleDelete}
              disabled={deleting}
              className="bg-red-600 text-white hover:bg-red-700 disabled:opacity-50"
            >
              {deleting ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Trash2 className="h-4 w-4" />
              )}
              {t('Delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

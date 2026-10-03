'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { Broadcast } from '@/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Plus, Loader2, Trash2, Rows4, Search } from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '@/hooks/use-auth';
import { useCan } from '@/hooks/use-can';
import { useLanguage } from '@/hooks/use-language';
import { GatedButton } from '@/components/ui/gated-button';
import { cn } from '@/lib/utils';
import {
  BROADCASTS_COPY,
  BroadcastListRow,
  filterBroadcasts,
  readBroadcastsDensity,
  writeBroadcastsDensity,
  type BroadcastStatusFilter,
  type BroadcastsDensity,
} from '@/components/broadcasts/broadcast-list-row';

/**
 * Poll cadence while any broadcast is sending. Kept modest so we don't
 * beat on Supabase — the aggregate trigger in migration 003 keeps
 * counts consistent; we just need to surface the freshest snapshot.
 */
const POLL_INTERVAL_MS = 5_000;

const STATUS_FILTERS: readonly BroadcastStatusFilter[] = ['all', 'draft', 'scheduled', 'sending', 'sent', 'failed'];

const pill =
  'inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full px-3 text-xs font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none';

export default function BroadcastsPage() {
  const router = useRouter();
  const { t, language } = useLanguage();
  const copy = BROADCASTS_COPY[language] ?? BROADCASTS_COPY['pt-BR'];
  const canCreate = useCan('send-messages');
  const userId = useAuth().user?.id;
  const [broadcasts, setBroadcasts] = useState<Broadcast[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Broadcast | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [statusFilter, setStatusFilter] = useState<BroadcastStatusFilter>('all');
  const [query, setQuery] = useState('');

  // Row density, per user on this device (read after mount: no hydration mismatch).
  const [density, setDensity] = useState<BroadcastsDensity>('comfortable');
  useEffect(() => {
    if (userId) setDensity(readBroadcastsDensity(userId));
  }, [userId]);
  const toggleDensity = useCallback(() => {
    setDensity((d) => {
      const next: BroadcastsDensity = d === 'compact' ? 'comfortable' : 'compact';
      if (userId) writeBroadcastsDensity(userId, next);
      return next;
    });
  }, [userId]);

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

  const anySending = useMemo(() => broadcasts.some((b) => b.status === 'sending'), [broadcasts]);

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

  const counts = useMemo(() => {
    const out: Record<string, number> = { all: broadcasts.length };
    for (const b of broadcasts) out[b.status] = (out[b.status] ?? 0) + 1;
    return out;
  }, [broadcasts]);

  const visible = useMemo(
    () => filterBroadcasts(broadcasts, statusFilter, query),
    [broadcasts, statusFilter, query],
  );

  async function handleDelete() {
    if (!pendingDelete) return;
    setDeleting(true);
    const supabase = createClient();
    // broadcast_recipients cascades on broadcasts.id (migration 001), so
    // a single delete is sufficient — same rule as the detail page.
    const { error: delErr } = await supabase.from('broadcasts').delete().eq('id', pendingDelete.id);
    setDeleting(false);
    if (delErr) {
      toast.error(`${t('Failed to delete')}: ${delErr.message}`);
      return;
    }
    setBroadcasts((prev) => prev.filter((b) => b.id !== pendingDelete.id));
    setPendingDelete(null);
    toast.success(t('Broadcast deleted'));
  }

  const formatDate = (iso: string) =>
    new Date(iso).toLocaleDateString(language, { day: 'numeric', month: 'short', year: 'numeric' });
  const formatDateTime = (iso: string) =>
    new Date(iso).toLocaleString(language, { dateStyle: 'short', timeStyle: 'short' });

  if (error) {
    return (
      <div className="flex h-64 flex-col items-center justify-center gap-3">
        <p role="alert" className="text-sm text-muted-foreground">
          {t(error)}
        </p>
        <Button variant="outline" size="sm" onClick={() => window.location.reload()}>
          {t('Try again')}
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Thin indeterminate bar while a broadcast is mid-send. */}
      {anySending && (
        <div
          role="progressbar"
          aria-label={copy.inProgress}
          className="fixed inset-x-0 top-0 z-40 h-0.5 overflow-hidden bg-muted"
        >
          <div className="broadcast-indeterminate-bar h-0.5 bg-primary" />
          <style jsx>{`
            .broadcast-indeterminate-bar {
              width: 33%;
              transform: translateX(-100%);
              animation: broadcast-slide 1.6s cubic-bezier(0.4, 0, 0.2, 1) infinite;
            }
            @keyframes broadcast-slide {
              0% {
                transform: translateX(-100%);
              }
              100% {
                transform: translateX(400%);
              }
            }
            @media (prefers-reduced-motion: reduce) {
              .broadcast-indeterminate-bar {
                animation: none;
                transform: none;
              }
            }
          `}</style>
        </div>
      )}

      {/* Header: title + count, one filled action */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">{copy.title}</h1>
        {broadcasts.length > 0 && (
          <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-bold tabular-nums text-muted-foreground">
            {broadcasts.length}
          </span>
        )}
        <div className="ml-auto">
          <GatedButton
            size="sm"
            canAct={canCreate}
            gateReason="create broadcasts"
            onClick={() => router.push('/broadcasts/new')}
          >
            <Plus />
            {copy.newBroadcast}
          </GatedButton>
        </div>
      </div>

      {/* Search + status pills + density */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 max-w-xs flex-1 basis-48">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={copy.search}
            aria-label={copy.search}
            className="h-8 pl-8 text-sm"
          />
        </div>
        <div role="group" aria-label={copy.filters} className="order-last -mx-1 flex w-full min-w-0 gap-1 overflow-x-auto px-1 sm:order-none sm:w-auto">
          {STATUS_FILTERS.filter((s) => s === 'all' || s === statusFilter || (counts[s] ?? 0) > 0).map((s) => (
            <button
              key={s}
              type="button"
              aria-pressed={statusFilter === s}
              onClick={() => setStatusFilter(s)}
              className={cn(
                pill,
                statusFilter === s ? 'bg-primary/15 text-primary' : 'bg-muted text-muted-foreground hover:text-foreground',
              )}
            >
              {s === 'all' ? copy.all : copy.status[s]}
              <span className="tabular-nums opacity-70">{counts[s] ?? 0}</span>
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={toggleDensity}
          aria-pressed={density === 'compact'}
          aria-label={copy.compact}
          title={copy.compact}
          data-testid="broadcasts-density-toggle"
          className={cn(
            'ml-auto inline-flex size-7 shrink-0 items-center justify-center rounded-full transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none',
            density === 'compact'
              ? 'bg-primary/10 text-primary'
              : 'text-muted-foreground hover:bg-muted hover:text-foreground',
          )}
        >
          <Rows4 className="size-3.5" />
        </button>
      </div>

      {/* List: hairline rows, no box */}
      {loading ? (
        <p role="status" className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" aria-hidden />
          {copy.loading}
        </p>
      ) : visible.length === 0 ? (
        <div className="border-t border-border py-12 text-center">
          <p className="text-sm text-muted-foreground">{broadcasts.length === 0 ? copy.emptyAll : copy.emptyFilter}</p>
          {broadcasts.length === 0 && canCreate && (
            <Button variant="outline" size="sm" onClick={() => router.push('/broadcasts/new')} className="mt-3">
              <Plus />
              {copy.newBroadcast}
            </Button>
          )}
        </div>
      ) : (
        <ul className="border-t border-border">
          {visible.map((b) => (
            <BroadcastListRow
              key={b.id}
              broadcast={b}
              compact={density === 'compact'}
              copy={copy}
              dateLabel={formatDate(b.created_at)}
              scheduledLabel={b.status === 'scheduled' && b.scheduled_at ? formatDateTime(b.scheduled_at) : null}
              onDelete={() => setPendingDelete(b)}
            />
          ))}
        </ul>
      )}

      <Dialog
        open={pendingDelete !== null}
        onOpenChange={(isOpen) => {
          if (!isOpen && !deleting) setPendingDelete(null);
        }}
      >
        <DialogContent className="border-border bg-popover sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-popover-foreground">{t('Delete broadcast')}</DialogTitle>
            <DialogDescription className="text-muted-foreground">
              <span className="font-medium text-popover-foreground">{pendingDelete?.name}</span>
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
            <Button variant="destructive" onClick={handleDelete} disabled={deleting}>
              {deleting ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
              {t('Delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

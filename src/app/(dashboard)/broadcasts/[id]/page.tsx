'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { Broadcast, BroadcastRecipient, RecipientStatus } from '@/types';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  ArrowLeft,
  Loader2,
  Filter,
  Download,
  ChevronDown,
  Trash2,
  PlayCircle,
  RotateCcw,
} from 'lucide-react';
import { toast } from 'sonner';
import { useLanguage } from '@/hooks/use-language';
import { cn } from '@/lib/utils';
import { getRecipientStatus } from '@/lib/broadcast-status';
import { isDeliveryActive } from '@/lib/broadcast-delivery-lock';
import { useCan } from '@/hooks/use-can';
import {
  BROADCASTS_COPY,
  BroadcastProgressLine,
  BroadcastStatusLabel,
  broadcastProgress,
  rate,
} from '@/components/broadcasts/broadcast-list-row';

/** Small muted uppercase section title — same as the inbox contact panel. */
const SECTION_TITLE = 'text-[10.5px] font-semibold uppercase tracking-[0.07em] text-muted-foreground';
const TH = 'h-9 px-2 text-left text-xs font-medium text-muted-foreground';

/** Recipient status as dot + text: brand tints for the happy path, amber/red for attention. */
const RECIPIENT_DOT: Record<RecipientStatus, string> = {
  pending: 'bg-muted-foreground/50',
  sending: 'bg-amber-500 motion-safe:animate-pulse',
  sent: 'bg-primary/40',
  delivered: 'bg-primary/70',
  read: 'bg-primary',
  replied: 'bg-primary',
  failed: 'bg-red-500',
  uncertain: 'bg-amber-500',
};

interface FunnelStep {
  label: string;
  value: number;
}

/**
 * Funnel as hairline rows: label, a thin bar relative to Sent, value and
 * share of Sent. One brand colour, no boxes.
 */
function FunnelRows({ title, steps }: { title: string; steps: FunnelStep[] }) {
  const base = steps[0]?.value ?? 0;
  const max = Math.max(...steps.map((s) => s.value), 1);
  return (
    <section className="space-y-2">
      <h2 className={SECTION_TITLE}>{title}</h2>
      <ul className="space-y-2">
        {steps.map((step) => (
          <li key={step.label} className="grid grid-cols-[6.5rem_1fr_auto] items-center gap-3 text-xs">
            <span className="truncate text-muted-foreground">{step.label}</span>
            <span aria-hidden className="h-1.5 overflow-hidden rounded-full bg-muted">
              <span
                className="block h-full rounded-full bg-primary transition-[width] duration-200 motion-reduce:transition-none"
                style={{ width: `${Math.round((step.value / max) * 100)}%` }}
              />
            </span>
            <span className="w-24 text-right tabular-nums text-foreground">
              {step.value.toLocaleString()}
              <span className="ml-1.5 text-muted-foreground">{rate(step.value, base)}%</span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

const RECIPIENT_STATUSES: readonly RecipientStatus[] = [
  'pending',
  'sending',
  'sent',
  'delivered',
  'read',
  'replied',
  'failed',
  'uncertain',
];

/** Row counts per actionable status — exact, never capped at 1000. */
interface OutstandingCounts {
  pending: number;
  sending: number;
  /** Failed under the claim protocol (confirmed) — retryable. */
  failed: number;
  /** Failed by the old browser-stamped code (claimed_at NULL) — never retried. */
  legacyFailed: number;
  uncertain: number;
}

const NO_COUNTS: OutstandingCounts = {
  pending: 0,
  sending: 0,
  failed: 0,
  legacyFailed: 0,
  uncertain: 0,
};

/**
 * CSV export helper — RFC 4180 quoting. Quote every field so
 * commas/newlines/quotes round-trip cleanly.
 */
function toCsv(rows: string[][]): string {
  const escape = (v: string) => `"${v.replace(/"/g, '""')}"`;
  return rows.map((r) => r.map(escape).join(',')).join('\n');
}

function downloadBlob(filename: string, content: string) {
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export default function BroadcastDetailPage() {
  const params = useParams();
  const router = useRouter();
  const { t, language } = useLanguage();
  const broadcastId = params.id as string;

  const [broadcast, setBroadcast] = useState<Broadcast | null>(null);
  const [recipients, setRecipients] = useState<BroadcastRecipient[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<RecipientStatus | 'all'>(
    'all',
  );
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [resumingScope, setResumingScope] = useState<
    'pending' | 'failed' | 'settle' | null
  >(null);
  const [counts, setCounts] = useState<OutstandingCounts>(NO_COUNTS);
  const canSend = useCan('send-messages');

  const fetchData = useCallback(async () => {
    try {
      const supabase = createClient();

      const { data: bc, error: bcError } = await supabase
        .from('broadcasts')
        .select('*')
        .eq('id', broadcastId)
        .single();

      if (bcError) throw bcError;
      setBroadcast(bc);

      const { data: recs, error: recsError } = await supabase
        .from('broadcast_recipients')
        .select('*, contact:contacts(*)')
        .eq('broadcast_id', broadcastId)
        .order('created_at', { ascending: false });

      if (recsError) throw recsError;
      setRecipients(recs ?? []);

      // The list above is capped at 1000 rows by PostgREST; the numbers
      // that drive Resume / Retry come from exact counts instead.
      const countOf = async (
        s: 'pending' | 'sending' | 'failed' | 'uncertain',
        claimed?: boolean,
      ) => {
        let q = supabase
          .from('broadcast_recipients')
          .select('id', { count: 'exact', head: true })
          .eq('broadcast_id', broadcastId)
          .eq('status', s);
        if (claimed === true) q = q.not('claimed_at', 'is', null);
        if (claimed === false) q = q.is('claimed_at', null);
        const { count } = await q;
        return count ?? 0;
      };
      const [pending, sending, failed, legacyFailed, uncertain] = await Promise.all([
        countOf('pending'),
        countOf('sending'),
        countOf('failed', true),
        countOf('failed', false),
        countOf('uncertain'),
      ]);
      setCounts({ pending, sending, failed, legacyFailed, uncertain });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load broadcast');
    } finally {
      setLoading(false);
    }
  }, [broadcastId]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const filteredRecipients = useMemo(
    () =>
      statusFilter === 'all'
        ? recipients
        : recipients.filter((r) => r.status === statusFilter),
    [recipients, statusFilter],
  );

  /**
   * The broadcasts row carries no sent_at of its own — derive the send
   * moment from the earliest recipient timestamp so the header can say
   * "Enviado em …" without a schema change.
   */
  const sentAt = useMemo(() => {
    let earliest: string | null = null;
    for (const r of recipients) {
      if (r.sent_at && (!earliest || r.sent_at < earliest)) earliest = r.sent_at;
    }
    return earliest;
  }, [recipients]);

  const formatDate = (iso: string) => new Date(iso).toLocaleDateString(language);
  const formatDateTime = (iso: string) =>
    new Date(iso).toLocaleString(language, {
      dateStyle: 'short',
      timeStyle: 'short',
    });

  function describeAudience(filter: Record<string, unknown> | undefined) {
    const type = typeof filter?.type === 'string' ? filter.type : 'all';
    if (type === 'tags') {
      const n = Array.isArray(filter?.tagIds) ? filter.tagIds.length : 0;
      return `${t('Tags')} (${n})`;
    }
    if (type === 'custom_field') return t('Custom Field');
    if (type === 'csv') return t('CSV list');
    return t('All Contacts');
  }

  function handleExport() {
    if (!broadcast) return;
    const header = [
      t('Contact'),
      t('Phone'),
      t('Status'),
      t('Sent At'),
      t('Delivered At'),
      t('Read At'),
      t('Replied At'),
      t('Error'),
    ];
    const rows = recipients.map((r) => [
      r.contact?.name ?? '',
      r.contact?.phone ?? '',
      t(getRecipientStatus(r.status).label),
      r.sent_at ?? '',
      r.delivered_at ?? '',
      r.read_at ?? '',
      r.replied_at ?? '',
      r.error_message ?? '',
    ]);
    const csv = toCsv([header, ...rows]);
    const safeName = broadcast.name.replace(/[^a-z0-9-_]+/gi, '-').toLowerCase();
    downloadBlob(`broadcast-${safeName}-${broadcastId.slice(0, 8)}.csv`, csv);
  }

  /**
   * Hand the leftovers to the server (wacrm #472). The wizard's send
   * loop lives in the tab that started the campaign, so closing it
   * strands the rest as 'pending' with the broadcast stuck in
   * 'sending'. This is the recovery, and the same call retries failed
   * recipients.
   */
  async function handleResume(scope: 'pending' | 'failed' | 'settle') {
    setResumingScope(scope);
    try {
      const res = await fetch(`/api/whatsapp/broadcast/${broadcastId}/resume`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope }),
      });
      const payload = await res.json().catch(() => ({}));

      if (!res.ok) {
        toast.error(
          `${t('Could not resume')}: ${t(payload?.error || `HTTP ${res.status}`)}`,
        );
        return;
      }

      if (scope === 'settle') {
        toast.success(t('Broadcast status updated.'));
        await fetchData();
        return;
      }

      toast.success(
        payload.remaining > 0
          ? `${t('Sending in the background')}: ${payload.resuming}. ${t('Left for another run')}: ${payload.remaining}.`
          : `${t('Sending in the background')}: ${payload.resuming}.`,
      );
      // Delivery runs server-side after the 202, so the counts here are
      // a snapshot — reload to pick up the first of it.
      await fetchData();
    } catch (err) {
      toast.error(
        `${t('Could not resume')}: ${t(err instanceof Error ? err.message : 'Unknown error')}`,
      );
    } finally {
      setResumingScope(null);
    }
  }

  async function handleDelete() {
    setDeleting(true);
    const supabase = createClient();
    // broadcast_recipients cascades on broadcasts.id (migration 001), so a
    // single delete is sufficient — the aggregate trigger in migration 003
    // is defined on broadcast_recipients but fires only on its own row
    // changes, not on a cascaded drop of the parent row.
    const { error: delErr } = await supabase
      .from('broadcasts')
      .delete()
      .eq('id', broadcastId);
    setDeleting(false);
    if (delErr) {
      toast.error(`${t('Failed to delete')}: ${delErr.message}`);
      return;
    }
    toast.success(t('Broadcast deleted'));
    router.push('/broadcasts');
  }

  if (loading) {
    return (
      <p role="status" className="flex h-64 items-center justify-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" aria-hidden />
        {t('Loading...')}
      </p>
    );
  }

  if (error || !broadcast) {
    return (
      <div className="flex h-64 flex-col items-center justify-center gap-3">
        <p role="alert" className="text-sm text-muted-foreground">
          {t(error ?? 'Broadcast not found')}
        </p>
        <Button variant="outline" size="sm" onClick={() => router.push('/broadcasts')}>
          {t('Back to Broadcasts')}
        </Button>
      </div>
    );
  }

  const copy = BROADCASTS_COPY[language] ?? BROADCASTS_COPY['pt-BR'];
  const progress = broadcastProgress(broadcast);

  const pendingCount = counts.pending;
  // Only CONFIRMED failures (under the claim protocol) are retryable;
  // 'uncertain' and old-code failures never are.
  const retryableCount = counts.failed;
  // Someone's tab (or a server pass) is still sending — a fresh lock, or
  // a lock-less 'sending' campaign whose counts moved recently. Resuming
  // now would be refused with 409 anyway.
  const deliveryActive = isDeliveryActive(broadcast);
  // A campaign whose tab went away sits in 'sending' with recipients
  // still pending and nothing left to move them. Name that state rather
  // than leaving a permanently "sending" badge.
  const isStalled =
    broadcast.status === 'sending' && pendingCount > 0 && !deliveryActive;
  // Rows claimed by a pass that is no longer running: their outcome is
  // unknown. Shown for review together with 'uncertain'; never resent.
  const orphanedSending = deliveryActive ? 0 : counts.sending;
  // Created by the old browser-stamped code: its 'pending' rows may have
  // been sent already, so it can't be resumed or retried safely.
  const isLegacy = broadcast.delivery_protocol == null;
  const uncertainTotal = counts.uncertain + orphanedSending;

  const funnelSteps: FunnelStep[] = [
    { label: t('Sent'), value: broadcast.sent_count },
    { label: t('Delivered'), value: broadcast.delivered_count },
    { label: t('Read'), value: broadcast.read_count },
    { label: t('Responded'), value: broadcast.replied_count },
  ];

  const total = broadcast.total_recipients;
  const stats = [
    { key: 'total', label: t('Total Recipients'), value: total, pct: null as number | null },
    { key: 'sent', label: t('Sent'), value: broadcast.sent_count, pct: rate(broadcast.sent_count, total) },
    { key: 'delivered', label: t('Delivered'), value: broadcast.delivered_count, pct: rate(broadcast.delivered_count, total) },
    { key: 'read', label: t('Read'), value: broadcast.read_count, pct: rate(broadcast.read_count, total) },
    { key: 'replied', label: t('Responded'), value: broadcast.replied_count, pct: rate(broadcast.replied_count, total) },
    { key: 'failed', label: t('Failed'), value: broadcast.failed_count, pct: rate(broadcast.failed_count, total) },
  ];

  const meta = [
    `${t('Template')}: ${broadcast.template_name}`,
    `${t('Audience')}: ${describeAudience(broadcast.audience_filter)}`,
    `${t('Created')} ${formatDate(broadcast.created_at)}`,
    sentAt
      ? `${t('Sent on')} ${formatDateTime(sentAt)}`
      : broadcast.status === 'scheduled' && broadcast.scheduled_at
        ? `${t('Scheduled for')} ${formatDateTime(broadcast.scheduled_at)}`
        : null,
  ].filter(Boolean);

  return (
    <div className="space-y-6">
      {/* Header: back, name, status (dot + text), one quiet meta line */}
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => router.push('/broadcasts')}
          aria-label={t('Back to Broadcasts')}
          className="mt-0.5 text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft />
        </Button>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <h1 className="min-w-0 truncate text-xl font-semibold tracking-tight text-foreground">{broadcast.name}</h1>
            <BroadcastStatusLabel status={broadcast.status} copy={copy} />
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">{meta.join(' · ')}</p>
        </div>

        {/* Delete — inline confirm. Mid-send broadcasts can't be deleted
            because orphaning in-flight Meta messages would leave the
            funnel inconsistent. */}
        {confirmDelete ? (
          <div className="flex items-center gap-1.5 text-sm" role="group" aria-label={t('Delete this broadcast?')}>
            <span className="text-muted-foreground">{t('Delete this broadcast?')}</span>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setConfirmDelete(false)}
              disabled={deleting}
              className="text-muted-foreground hover:text-foreground"
            >
              {t('Cancel')}
            </Button>
            <Button variant="destructive" size="sm" onClick={handleDelete} disabled={deleting}>
              {deleting ? t('Deleting…') : t('Confirm')}
            </Button>
          </div>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            disabled={broadcast.status === 'sending'}
            onClick={() => setConfirmDelete(true)}
            title={
              broadcast.status === 'sending'
                ? t('Cannot delete while a broadcast is actively sending')
                : t('Delete this broadcast')
            }
            className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
          >
            <Trash2 />
            {t('Delete')}
          </Button>
        )}
      </div>

      {/* Resume / retry (wacrm #472). Only rendered when something is
          outstanding and the viewer's role can send. */}
      {canSend && isLegacy && (pendingCount > 0 || retryableCount > 0) && (
        <section className="flex flex-wrap items-center justify-between gap-3 border-y border-border py-3 text-sm">
          <div className="min-w-0 max-w-2xl">
            <p className="font-medium text-foreground">{t('Created before this version — cannot be resumed')}</p>
            <p className="mt-0.5 text-muted-foreground">
              {t('This broadcast was created before this version and cannot be resumed safely: the previous version could send a message before recording it. Review the remaining recipients manually.')}
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => handleResume('settle')}
            disabled={resumingScope !== null}
            title={t('Nothing is sent: the remaining recipients are marked as uncertain for review and the broadcast status is closed.')}
          >
            {resumingScope === 'settle' && <Loader2 className="animate-spin" />}
            {t('Close this broadcast')}
          </Button>
        </section>
      )}

      {canSend && !isLegacy && (pendingCount > 0 || retryableCount > 0) && (
        <section className="flex flex-wrap items-center justify-between gap-3 border-y border-border py-3 text-sm">
          <div className="min-w-0 max-w-2xl">
            <p className="font-medium text-foreground">
              {deliveryActive
                ? t('This campaign is still sending')
                : isStalled
                  ? t('This campaign stopped part-way')
                  : t('Some recipients need another attempt')}
            </p>
            <p className="mt-0.5 text-muted-foreground">
              {deliveryActive
                ? t('Another tab or a background pass is delivering it. Resume and retry unlock when it finishes or stops responding for 10 minutes.')
                : isStalled
                  ? `${t('Recipients never sent')}: ${pendingCount}. ${t('The tab running this campaign was closed before it finished. Resuming completes it from the server.')}`
                  : `${t('Recipients that failed')}: ${retryableCount}. ${t('Retrying sends them again from the server.')}`}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {retryableCount > 0 && (
              <Button
                variant={pendingCount > 0 ? 'outline' : 'default'}
                size="sm"
                onClick={() => handleResume('failed')}
                disabled={resumingScope !== null || deliveryActive}
              >
                {resumingScope === 'failed' ? <Loader2 className="animate-spin" /> : <RotateCcw />}
                {t('Retry failed')} ({retryableCount})
              </Button>
            )}
            {pendingCount > 0 && (
              <Button
                size="sm"
                onClick={() => handleResume('pending')}
                disabled={resumingScope !== null || deliveryActive}
              >
                {resumingScope === 'pending' ? <Loader2 className="animate-spin" /> : <PlayCircle />}
                {t('Resume sending')} ({pendingCount})
              </Button>
            )}
          </div>
        </section>
      )}

      {/* Uncertain outcome: Meta may or may not have these. They are never
          resent automatically — a repeated broadcast gets the number
          banned — so the operator reviews them. */}
      {(uncertainTotal > 0 || counts.legacyFailed > 0) && (
        <section className="flex flex-wrap items-center justify-between gap-3 border-l-2 border-amber-500/70 py-1 pl-3 text-sm">
          <div className="min-w-0 max-w-2xl">
            {uncertainTotal > 0 && (
              <p className="inline-flex items-center gap-1.5 font-medium text-foreground">
                <span aria-hidden className="size-1.5 rounded-full bg-amber-500" />
                {t('Uncertain result')}: {uncertainTotal}
              </p>
            )}
            {counts.legacyFailed > 0 && (
              <p
                className="flex items-center gap-1.5 font-medium text-foreground"
                title={t('Marked failed by the previous version, which failed whole batches even when the server may have sent them — so they are never retried.')}
              >
                <span aria-hidden className="size-1.5 rounded-full bg-amber-500" />
                {t('Old failure (not retryable)')}: {counts.legacyFailed}
              </p>
            )}
            <p className="mt-0.5 text-muted-foreground">
              {uncertainTotal > 0
                ? t('The connection to Meta failed or the send was interrupted, so these messages may or may not have been delivered. They are never resent automatically — check them before contacting these people again.')
                : t('Marked failed by the previous version, which failed whole batches even when the server may have sent them — so they are never retried.')}
            </p>
          </div>
          {canSend && orphanedSending > 0 && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => handleResume('settle')}
              disabled={resumingScope !== null}
              title={t('Rows interrupted more than 10 minutes ago are marked as uncertain and the broadcast status is settled.')}
            >
              {resumingScope === 'settle' && <Loader2 className="animate-spin" />}
              {t('Settle interrupted sends')}
            </Button>
          )}
        </section>
      )}

      {/* Numbers strip — no boxes; the progress line underneath. */}
      <section className="space-y-3">
        <dl className="grid grid-cols-3 gap-x-6 gap-y-3 sm:grid-cols-6">
          {stats.map((s) => (
            <div key={s.key} className="min-w-0">
              <dt className="flex items-center gap-1.5 truncate text-xs text-muted-foreground">
                {s.key === 'failed' && s.value > 0 && (
                  <span aria-hidden className="size-1.5 rounded-full bg-red-500" />
                )}
                {s.label}
              </dt>
              <dd className="mt-0.5 flex items-baseline gap-1.5">
                <span className="text-lg font-semibold tabular-nums text-foreground">{s.value.toLocaleString(language)}</span>
                {s.pct !== null && <span className="text-xs tabular-nums text-muted-foreground">{s.pct}%</span>}
              </dd>
            </div>
          ))}
        </dl>
        {progress && <BroadcastProgressLine progress={progress} className="h-1" />}
      </section>

      <FunnelRows title={t('Funnel')} steps={funnelSteps} />

      {/* Recipients — card-less table, hairline rows */}
      <section className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className={SECTION_TITLE}>
            {t('Recipients')}{' '}
            <span className="tabular-nums">
              {filteredRecipients.length}
              {statusFilter !== 'all' ? ` ${t('of')} ${recipients.length}` : ''}
            </span>
          </h2>
          <div className="flex items-center gap-1">
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="ghost"
                    size="sm"
                    className={cn(
                      statusFilter === 'all' ? 'text-muted-foreground hover:text-foreground' : 'bg-primary/15 text-primary',
                    )}
                  />
                }
              >
                <Filter />
                {statusFilter === 'all' ? t('All statuses') : t(getRecipientStatus(statusFilter).label)}
                <ChevronDown className="size-3" />
              </DropdownMenuTrigger>
              <DropdownMenuContent className="border-border bg-popover">
                <DropdownMenuItem
                  onClick={() => setStatusFilter('all')}
                  className={statusFilter === 'all' ? 'text-primary' : 'text-popover-foreground'}
                >
                  {t('All statuses')}
                </DropdownMenuItem>
                {RECIPIENT_STATUSES.map((s) => (
                  <DropdownMenuItem
                    key={s}
                    onClick={() => setStatusFilter(s)}
                    className={statusFilter === s ? 'text-primary' : 'text-popover-foreground'}
                  >
                    <span aria-hidden className={cn('size-1.5 rounded-full', RECIPIENT_DOT[s])} />
                    {t(getRecipientStatus(s).label)}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>

            <Button
              variant="ghost"
              size="sm"
              onClick={handleExport}
              disabled={recipients.length === 0}
              className="text-muted-foreground hover:text-foreground"
            >
              <Download />
              {t('Export CSV')}
            </Button>
          </div>
        </div>

        {filteredRecipients.length === 0 ? (
          <p className="border-t border-border py-10 text-center text-sm text-muted-foreground">
            {recipients.length === 0 ? t('No recipients found.') : t('No recipients match this filter.')}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-y border-border">
                  <th scope="col" className={cn(TH, 'pl-0')}>{t('Contact')}</th>
                  <th scope="col" className={cn(TH, 'hidden sm:table-cell')}>{t('Phone')}</th>
                  <th scope="col" className={TH}>{t('Status')}</th>
                  <th scope="col" className={cn(TH, 'hidden lg:table-cell')}>{t('Sent')}</th>
                  <th scope="col" className={cn(TH, 'hidden lg:table-cell')}>{t('Delivered')}</th>
                  <th scope="col" className={cn(TH, 'hidden lg:table-cell')}>{t('Read')}</th>
                  <th scope="col" className={cn(TH, 'hidden md:table-cell')}>{t('Error')}</th>
                </tr>
              </thead>
              <tbody>
                {filteredRecipients.map((recipient) => (
                  <tr key={recipient.id} className="border-b border-border">
                    <td className="max-w-48 truncate py-2 pr-2 font-medium text-foreground">
                      {recipient.contact?.name ?? t('Unknown contact')}
                    </td>
                    <td className="hidden px-2 py-2 tabular-nums text-muted-foreground sm:table-cell">
                      {recipient.contact?.phone ?? '—'}
                    </td>
                    <td className="whitespace-nowrap px-2 py-2">
                      <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                        <span
                          aria-hidden
                          className={cn('size-1.5 rounded-full', RECIPIENT_DOT[recipient.status] ?? RECIPIENT_DOT.pending)}
                        />
                        {t(getRecipientStatus(recipient.status).label)}
                      </span>
                    </td>
                    <td className="hidden whitespace-nowrap px-2 py-2 text-xs tabular-nums text-muted-foreground lg:table-cell">
                      {recipient.sent_at ? formatDateTime(recipient.sent_at) : '—'}
                    </td>
                    <td className="hidden whitespace-nowrap px-2 py-2 text-xs tabular-nums text-muted-foreground lg:table-cell">
                      {recipient.delivered_at ? formatDateTime(recipient.delivered_at) : '—'}
                    </td>
                    <td className="hidden whitespace-nowrap px-2 py-2 text-xs tabular-nums text-muted-foreground lg:table-cell">
                      {recipient.read_at ? formatDateTime(recipient.read_at) : '—'}
                    </td>
                    <td
                      className={cn(
                        'hidden max-w-xs truncate px-2 py-2 text-xs md:table-cell',
                        recipient.error_message ? 'text-red-600 dark:text-red-400' : 'text-muted-foreground',
                      )}
                      title={recipient.error_message ?? undefined}
                    >
                      {recipient.error_message ?? '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

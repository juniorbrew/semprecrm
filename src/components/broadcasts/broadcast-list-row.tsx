'use client';

import Link from 'next/link';
import { Eye, MoreHorizontal, Trash2 } from 'lucide-react';
import type { Broadcast, BroadcastStatus } from '@/types';
import type { Language } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

/** Row density of the broadcasts list, per user on this device. */
export type BroadcastsDensity = 'comfortable' | 'compact';
const DENSITY_KEY_PREFIX = 'sempre:broadcasts:density:';

export function readBroadcastsDensity(userId: string): BroadcastsDensity {
  try {
    return localStorage.getItem(DENSITY_KEY_PREFIX + userId) === 'compact' ? 'compact' : 'comfortable';
  } catch {
    return 'comfortable';
  }
}

export function writeBroadcastsDensity(userId: string, density: BroadcastsDensity): void {
  try {
    localStorage.setItem(DENSITY_KEY_PREFIX + userId, density);
  } catch {
    // Persistence is best-effort.
  }
}

/** Status as a dot + text. Amber/red only where it needs attention. */
export const BROADCAST_STATUS_DOT: Record<BroadcastStatus, string> = {
  draft: 'bg-muted-foreground/50',
  scheduled: 'bg-sky-500',
  sending: 'bg-amber-500 motion-safe:animate-pulse',
  sent: 'bg-emerald-500',
  failed: 'bg-red-500',
};

export function broadcastStatusDot(status: string): string {
  return BROADCAST_STATUS_DOT[status as BroadcastStatus] ?? BROADCAST_STATUS_DOT.draft;
}

/**
 * Widths (0–100) of the thin progress line under a row, as shares of
 * the audience. The counts are cumulative (migration 005: read ⊆
 * delivered ⊆ sent), so each segment is the part not already counted by
 * the next stage. `null` when there is nothing sent to show yet.
 */
export interface BroadcastProgress {
  read: number;
  delivered: number;
  sent: number;
  failed: number;
}

export function broadcastProgress(
  b: Pick<Broadcast, 'status' | 'total_recipients' | 'sent_count' | 'delivered_count' | 'read_count' | 'failed_count'>,
): BroadcastProgress | null {
  const total = b.total_recipients;
  if (!total || b.status === 'draft' || b.status === 'scheduled') return null;
  const pct = (n: number) => Math.max(0, Math.min(100, (n / total) * 100));
  const read = Math.min(b.read_count, b.delivered_count, b.sent_count);
  const delivered = Math.min(b.delivered_count, b.sent_count);
  return {
    read: pct(read),
    delivered: pct(delivered - read),
    sent: pct(b.sent_count - delivered),
    failed: pct(b.failed_count),
  };
}

/** Rounded % of the audience, 0 when there is none. */
export function rate(value: number, total: number): number {
  return total ? Math.round((value / total) * 100) : 0;
}

export type BroadcastStatusFilter = BroadcastStatus | 'all';

/** Client-side filter over the loaded list — status pill + name/template search. */
export function filterBroadcasts<T extends Pick<Broadcast, 'name' | 'template_name' | 'status'>>(
  list: readonly T[],
  status: BroadcastStatusFilter,
  query: string,
): T[] {
  const q = query.trim().toLowerCase();
  return list.filter(
    (b) =>
      (status === 'all' || b.status === status) &&
      (!q || b.name.toLowerCase().includes(q) || b.template_name.toLowerCase().includes(q)),
  );
}

export const BROADCASTS_COPY = {
  'pt-BR': {
    title: 'Disparos',
    newBroadcast: 'Novo disparo',
    search: 'Buscar por nome ou modelo',
    compact: 'Lista compacta',
    all: 'Todos',
    status: {
      draft: 'Rascunho',
      scheduled: 'Agendado',
      sending: 'Enviando',
      sent: 'Enviado',
      failed: 'Falhou',
    } satisfies Record<BroadcastStatus, string>,
    filters: 'Filtrar por situação',
    recipients: (n: number) => (n === 1 ? '1 destinatário' : `${n} destinatários`),
    scheduledFor: (when: string) => `Agendado para ${when}`,
    delivered: 'entregues',
    read: 'lidas',
    failed: (n: number) => (n === 1 ? '1 falha' : `${n} falhas`),
    uncertain: (n: number) => `${n} incerto${n === 1 ? '' : 's'}`,
    uncertainTitle: 'A Meta pode ou não ter recebido estas mensagens. Nunca são reenviadas automaticamente.',
    open: (name: string) => `Abrir ${name}`,
    more: (name: string) => `Mais ações para ${name}`,
    view: 'Ver detalhes',
    delete: 'Excluir',
    loading: 'Carregando disparos…',
    emptyAll: 'Nenhum disparo ainda.',
    emptyFilter: 'Nenhum disparo encontrado.',
    inProgress: 'Disparo em andamento',
  },
  'en-US': {
    title: 'Broadcasts',
    newBroadcast: 'New broadcast',
    search: 'Search by name or template',
    compact: 'Compact list',
    all: 'All',
    status: {
      draft: 'Draft',
      scheduled: 'Scheduled',
      sending: 'Sending',
      sent: 'Sent',
      failed: 'Failed',
    } satisfies Record<BroadcastStatus, string>,
    filters: 'Filter by status',
    recipients: (n: number) => (n === 1 ? '1 recipient' : `${n} recipients`),
    scheduledFor: (when: string) => `Scheduled for ${when}`,
    delivered: 'delivered',
    read: 'read',
    failed: (n: number) => `${n} failed`,
    uncertain: (n: number) => `${n} uncertain`,
    uncertainTitle: 'Meta may or may not have received these messages. They are never resent automatically.',
    open: (name: string) => `Open ${name}`,
    more: (name: string) => `More actions for ${name}`,
    view: 'View details',
    delete: 'Delete',
    loading: 'Loading broadcasts…',
    emptyAll: 'No broadcasts yet.',
    emptyFilter: 'No broadcasts match.',
    inProgress: 'Broadcast in progress',
  },
} satisfies Record<Language, Record<string, unknown>>;

export type BroadcastsCopy = (typeof BROADCASTS_COPY)['pt-BR'];

export function broadcastStatusLabel(copy: BroadcastsCopy, status: string): string {
  return copy.status[status as BroadcastStatus] ?? copy.status.draft;
}

/** Dot + text, never colour alone. */
export function BroadcastStatusLabel({ status, copy, className }: { status: string; copy: BroadcastsCopy; className?: string }) {
  return (
    <span className={cn('inline-flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground', className)}>
      <span aria-hidden className={cn('size-1.5 rounded-full', broadcastStatusDot(status))} />
      {broadcastStatusLabel(copy, status)}
    </span>
  );
}

/** Thin stacked line: read, delivered, sent (brand tints), failed (red). */
export function BroadcastProgressLine({ progress, className }: { progress: BroadcastProgress; className?: string }) {
  return (
    <span
      aria-hidden
      data-testid="broadcast-progress"
      className={cn('flex h-0.5 overflow-hidden rounded-full bg-border', className)}
    >
      <span className="h-full bg-primary" style={{ width: `${progress.read}%` }} />
      <span className="h-full bg-primary/60" style={{ width: `${progress.delivered}%` }} />
      <span className="h-full bg-primary/25" style={{ width: `${progress.sent}%` }} />
      <span className="ml-auto h-full bg-red-500" style={{ width: `${progress.failed}%` }} />
    </span>
  );
}

export interface BroadcastListRowProps {
  broadcast: Broadcast;
  compact: boolean;
  copy: BroadcastsCopy;
  /** Already formatted for the user's locale. */
  dateLabel: string;
  scheduledLabel: string | null;
  onDelete: () => void;
}

/**
 * One campaign: name and status (dot + text) on the first line, a quiet
 * metadata line (template · recipients · date) and delivery rates, then
 * a thin progress line along the bottom edge.
 */
export function BroadcastListRow({ broadcast: b, compact, copy, dateLabel, scheduledLabel, onDelete }: BroadcastListRowProps) {
  const progress = broadcastProgress(b);
  const uncertain = b.uncertain_count ?? 0;
  const meta = [
    b.template_name,
    b.status === 'draft' && b.total_recipients === 0 ? null : copy.recipients(b.total_recipients),
    scheduledLabel ? copy.scheduledFor(scheduledLabel) : dateLabel,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <li className="group/row relative flex items-center gap-2 border-b border-border pr-2 transition-colors duration-150 hover:bg-muted/50 motion-reduce:transition-none">
      <Link
        href={`/broadcasts/${b.id}`}
        aria-label={copy.open(b.name)}
        className={cn(
          'flex min-w-0 flex-1 flex-col gap-0.5 rounded-md px-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
          compact ? 'py-2' : 'py-3',
        )}
      >
        <span className="flex min-w-0 items-center gap-3">
          <span className="min-w-0 truncate text-sm font-medium text-foreground">{b.name}</span>
          <BroadcastStatusLabel status={b.status} copy={copy} />
          {compact && <span className="hidden min-w-0 truncate text-xs text-muted-foreground lg:inline">{meta}</span>}
          {progress && (
            <span className="ml-auto hidden shrink-0 items-center gap-3 text-xs tabular-nums text-muted-foreground md:flex">
              <span>
                {rate(b.delivered_count, b.total_recipients)}% {copy.delivered}
              </span>
              <span>
                {rate(b.read_count, b.total_recipients)}% {copy.read}
              </span>
              {b.failed_count > 0 && (
                <span className="text-red-600 dark:text-red-400">
                  {copy.failed(b.failed_count)}
                </span>
              )}
            </span>
          )}
        </span>
        {!compact && (
          <span className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
            <span className="min-w-0 truncate tabular-nums">{meta}</span>
            {uncertain > 0 && (
              <span title={copy.uncertainTitle} className="inline-flex shrink-0 items-center gap-1.5">
                <span aria-hidden className="size-1.5 rounded-full bg-amber-500" />
                {copy.uncertain(uncertain)}
              </span>
            )}
          </span>
        )}
      </Link>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={copy.more(b.name)}
              className="shrink-0 text-muted-foreground hover:text-foreground"
            />
          }
        >
          <MoreHorizontal className="size-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="border-border bg-popover">
          <DropdownMenuItem
            render={<Link href={`/broadcasts/${b.id}`} />}
            className="text-popover-foreground focus:bg-muted focus:text-foreground"
          >
            <Eye className="size-4" />
            {copy.view}
          </DropdownMenuItem>
          <DropdownMenuItem variant="destructive" disabled={b.status === 'sending'} onClick={onDelete}>
            <Trash2 className="size-4" />
            {copy.delete}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {progress && <BroadcastProgressLine progress={progress} className="pointer-events-none absolute inset-x-3 bottom-0" />}
    </li>
  );
}

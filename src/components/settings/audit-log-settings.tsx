'use client';

import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Loader2, RefreshCw, ScrollText } from 'lucide-react';

import { useAuth } from '@/hooks/use-auth';
import { useLanguage } from '@/hooks/use-language';
import {
  AUDIT_ACTION_LIST,
  auditActionLabel,
  type AuditLogRow,
} from '@/lib/audit';
import type { AccountMember } from '@/types';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';

import { SettingsPanelHead } from './settings-panel-head';

const SELECT_CLASS =
  'h-8 rounded-md border border-border bg-muted px-2 text-xs text-foreground focus:border-primary focus:outline-none';

const PAGE_SIZE = 50;

type Period = '7d' | '30d' | '90d' | 'all';

const PERIODS: { value: Period; label: string }[] = [
  { value: '7d', label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' },
  { value: '90d', label: 'Last 90 days' },
  { value: 'all', label: 'All time' },
];

/** Entity labels shown in the "Entity" column. */
const ENTITY_LABELS: Record<string, string> = {
  account: 'Account',
  member: 'Member',
  invitation: 'Invitation',
  whatsapp_config: 'Official WhatsApp',
  wa_qr_session: 'WhatsApp QR',
  contact: 'Contact',
  deal: 'Deal',
  automation: 'Automation',
  lead_source: 'Lead source',
  preferences: 'Preferences',
  branding: 'Branding',
  plan: 'Plan',
  mfa: 'Two-step verification',
};

/** Role values stored in metadata (`role`, `from`, `to`) → English label keys. */
const ROLE_LABELS: Record<string, string> = {
  owner: 'Owner',
  admin: 'Admin',
  agent: 'Agent',
  viewer: 'Viewer',
};

function roleLabel(value: string, t: (s: string) => string): string {
  return ROLE_LABELS[value] ? t(ROLE_LABELS[value]) : value;
}

function periodStart(period: Period): string | null {
  if (period === 'all') return null;
  const days = period === '7d' ? 7 : period === '30d' ? 30 : 90;
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

/**
 * Short, human summary of `metadata` for the collapsed row. Picks the
 * fields the writers actually set; everything else lives in the
 * expandable JSON.
 */
function summarize(row: AuditLogRow, t: (s: string) => string): string | null {
  const m = row.metadata ?? {};
  const parts: string[] = [];
  const name =
    (m.contact_name as string | undefined) ??
    (m.member_name as string | undefined) ??
    (m.name as string | undefined);
  if (name) parts.push(name);
  if (typeof m.from === 'string' && typeof m.to === 'string') {
    parts.push(`${roleLabel(m.from, t)} → ${roleLabel(m.to, t)}`);
  } else if (m.role && typeof m.role === 'string') {
    parts.push(roleLabel(m.role, t));
  }
  if (Array.isArray(m.keys) && m.keys.length > 0) {
    parts.push((m.keys as string[]).join(', '));
  }
  if (m.changes && typeof m.changes === 'object' && !Array.isArray(m.changes)) {
    const keys = Object.keys(m.changes as Record<string, unknown>);
    if (keys.length > 0 && !Array.isArray(m.keys)) parts.push(keys.join(', '));
  }
  if (typeof m.phone_number === 'string' && m.phone_number) parts.push(m.phone_number);
  if (typeof m.count === 'number') parts.push(`${m.count} ${t('items')}`);
  return parts.length > 0 ? parts.join(' · ') : null;
}

export function AuditLogSettings() {
  const { t, language } = useLanguage();
  const { canManageMembers, profileLoading } = useAuth();

  const [entries, setEntries] = useState<AuditLogRow[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const [action, setAction] = useState<string>('');
  const [actor, setActor] = useState<string>('');
  const [period, setPeriod] = useState<Period>('30d');

  const [members, setMembers] = useState<AccountMember[]>([]);

  const dateFmt = useMemo(
    () =>
      new Intl.DateTimeFormat(language, {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      }),
    [language],
  );

  useEffect(() => {
    if (!canManageMembers) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/account/members', { cache: 'no-store' });
        if (!res.ok) return;
        const body = (await res.json()) as { members?: AccountMember[] };
        if (!cancelled) setMembers(body.members ?? []);
      } catch {
        // The member filter is a convenience; the table still works.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [canManageMembers]);

  const buildUrl = useCallback(
    (cursor: string | null) => {
      const params = new URLSearchParams();
      params.set('limit', String(PAGE_SIZE));
      if (action) params.set('action', action);
      if (actor) params.set('actor', actor);
      const from = periodStart(period);
      if (from) params.set('from', from);
      if (cursor) params.set('cursor', cursor);
      return `/api/audit?${params.toString()}`;
    },
    [action, actor, period],
  );

  const load = useCallback(
    async (cursor: string | null) => {
      if (cursor) setLoadingMore(true);
      else setLoading(true);
      setError(null);
      try {
        const res = await fetch(buildUrl(cursor), { cache: 'no-store' });
        const body = (await res.json().catch(() => null)) as
          | { entries?: AuditLogRow[]; nextCursor?: string | null; error?: string }
          | null;
        if (!res.ok) throw new Error(body?.error ?? `${t('Request failed')} (HTTP ${res.status})`);
        const page = body?.entries ?? [];
        setEntries((prev) => (cursor ? [...prev, ...page] : page));
        setNextCursor(body?.nextCursor ?? null);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [buildUrl, t],
  );

  useEffect(() => {
    if (profileLoading || !canManageMembers) return;
    setExpanded(new Set());
    void load(null);
  }, [load, profileLoading, canManageMembers]);

  function toggle(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  if (!profileLoading && !canManageMembers) {
    return (
      <section className="animate-in fade-in-50 duration-200">
        <SettingsPanelHead title={t('Audit log')} />
        <Card className="p-6 text-sm text-muted-foreground">
          {t('Only admins can view the audit log.')}
        </Card>
      </section>
    );
  }

  const hasFilters = !!action || !!actor || period !== 'all';

  return (
    <section className="animate-in fade-in-50 duration-200">
      <SettingsPanelHead
        title={t('Audit log')}
        description={t(
          'Sensitive actions in this workspace — members, channels, contacts, plan — with who did them and when. Entries are kept for 365 days.',
        )}
        action={
          <Button
            variant="outline"
            size="sm"
            onClick={() => void load(null)}
            disabled={loading}
            className="gap-1.5"
          >
            {loading ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <RefreshCw className="size-3.5" />
            )}
            {t('Refresh')}
          </Button>
        }
      />

      {/* Filters */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span>{t('Action')}</span>
          <select
            aria-label={t('Action')}
            className={SELECT_CLASS}
            value={action}
            onChange={(e) => setAction(e.target.value)}
          >
            <option value="">{t('All actions')}</option>
            {AUDIT_ACTION_LIST.map((a) => (
              <option key={a} value={a}>
                {auditActionLabel(a, language)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span>{t('Member')}</span>
          <select
            aria-label={t('Member')}
            className={SELECT_CLASS}
            value={actor}
            onChange={(e) => setActor(e.target.value)}
          >
            <option value="">{t('All members')}</option>
            {members.map((m) => (
              <option key={m.user_id} value={m.user_id}>
                {m.full_name || m.email || m.user_id}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span>{t('Period')}</span>
          <select
            aria-label={t('Period')}
            className={SELECT_CLASS}
            value={period}
            onChange={(e) => setPeriod(e.target.value as Period)}
          >
            {PERIODS.map((p) => (
              <option key={p.value} value={p.value}>
                {t(p.label)}
              </option>
            ))}
          </select>
        </label>
        {hasFilters && (
          <button
            type="button"
            className="text-xs text-primary underline-offset-2 hover:underline"
            onClick={() => {
              setAction('');
              setActor('');
              setPeriod('all');
            }}
          >
            {t('Clear filters')}
          </button>
        )}
      </div>

      <Card className="overflow-hidden p-0">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : error ? (
          <div className="px-4 py-8 text-center text-sm text-destructive">{error}</div>
        ) : entries.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-4 py-12 text-center">
            <ScrollText className="size-6 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">
              {hasFilters
                ? t('No entries match these filters.')
                : t('Nothing recorded yet. Sensitive actions will show up here.')}
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-8" />
                  <TableHead className="whitespace-nowrap">{t('When')}</TableHead>
                  <TableHead className="whitespace-nowrap">{t('Who')}</TableHead>
                  <TableHead className="whitespace-nowrap">{t('Action')}</TableHead>
                  <TableHead className="whitespace-nowrap">{t('Entity')}</TableHead>
                  <TableHead>{t('Details')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {entries.map((row) => {
                  const open = expanded.has(row.id);
                  const summary = summarize(row, t);
                  const hasMeta = row.metadata && Object.keys(row.metadata).length > 0;
                  return (
                    <Fragment key={row.id}>
                      <TableRow
                        data-audit-row={row.action}
                        className={cn(hasMeta && 'cursor-pointer')}
                        onClick={() => hasMeta && toggle(row.id)}
                      >
                        <TableCell className="px-2 text-muted-foreground">
                          {hasMeta ? (
                            open ? (
                              <ChevronDown className="size-3.5" />
                            ) : (
                              <ChevronRight className="size-3.5" />
                            )
                          ) : null}
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-xs tabular-nums text-muted-foreground">
                          {dateFmt.format(new Date(row.created_at))}
                        </TableCell>
                        <TableCell className="max-w-[180px] truncate text-sm text-foreground">
                          {row.actor_name || (row.actor_user_id ? t('Member') : t('System'))}
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-sm text-foreground">
                          {auditActionLabel(row.action, language)}
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                          {t(ENTITY_LABELS[row.entity_type] ?? row.entity_type)}
                          {row.entity_id ? (
                            <span
                              className="ml-1 font-mono text-[10px] opacity-70"
                              title={row.entity_id}
                            >
                              {row.entity_id.slice(0, 8)}
                            </span>
                          ) : null}
                        </TableCell>
                        <TableCell className="max-w-[320px] truncate text-xs text-muted-foreground">
                          {summary ?? '—'}
                        </TableCell>
                      </TableRow>
                      {open && hasMeta && (
                        <TableRow className="bg-muted/30 hover:bg-muted/30">
                          <TableCell colSpan={6} className="px-4 py-3">
                            <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted px-3 py-2 font-mono text-[11px] leading-relaxed text-foreground">
                              {JSON.stringify(row.metadata, null, 2)}
                            </pre>
                          </TableCell>
                        </TableRow>
                      )}
                    </Fragment>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}

        {!loading && !error && nextCursor && (
          <div className="border-t border-border px-4 py-3 text-center">
            <Button
              variant="outline"
              size="sm"
              disabled={loadingMore}
              onClick={() => void load(nextCursor)}
              className="gap-1.5"
            >
              {loadingMore ? <Loader2 className="size-3.5 animate-spin" /> : null}
              {t('Load more')}
            </Button>
          </div>
        )}
      </Card>
    </section>
  );
}

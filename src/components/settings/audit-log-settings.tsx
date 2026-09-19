'use client';

import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Loader2, RefreshCw, ScrollText } from 'lucide-react';

import { useAuth } from '@/hooks/use-auth';
import { useLanguage } from '@/hooks/use-language';
import {
  AUDIT_ACTION_LIST,
  AUDIT_ROLE_LABELS,
  auditActionLabel,
  auditActorLabel,
  auditEntityLabel,
  auditFieldLabel,
  type AuditLogRow,
} from '@/lib/audit';
import type { Language } from '@/lib/i18n';
import {
  LIMIT_LABELS,
  MODULE_LABELS,
  PLAN_LABELS,
  PLAN_STATUS_LABELS,
  isLimitKey,
  isModule,
  isPlan,
  isPlanStatus,
} from '@/lib/plans';
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

function roleLabel(value: string, language: Language): string {
  return AUDIT_ROLE_LABELS[language][value] ?? value;
}

/** Enum codes that show up as metadata values → English label keys. */
const VALUE_LABELS: Record<string, string> = {
  pf: 'Pessoa física',
  pj: 'Pessoa jurídica',
  totp: 'Authenticator app',
  connected: 'Connected',
  disconnected: 'Disconnected',
  qr_pending: 'Waiting for QR scan',
};

/** Nested keys (module / limit overrides) reuse the plan catalogue labels. */
function keyLabel(key: string, language: Language, t: (s: string) => string): string {
  if (isModule(key)) return t(MODULE_LABELS[key]);
  if (isLimitKey(key)) return t(LIMIT_LABELS[key]);
  return auditFieldLabel(key, language);
}

function scalarLabel(value: string, language: Language, t: (s: string) => string): string {
  const role = AUDIT_ROLE_LABELS[language][value];
  if (role) return role;
  if (isPlan(value)) return t(PLAN_LABELS[value]);
  if (isPlanStatus(value)) return t(PLAN_STATUS_LABELS[value]);
  if (VALUE_LABELS[value]) return t(VALUE_LABELS[value]);
  return value;
}

function periodStart(period: Period): string | null {
  if (period === 'all') return null;
  const days = period === '7d' ? 7 : period === '30d' ? 30 : 90;
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

/**
 * Short, human summary of `metadata` for the collapsed row. Picks the
 * fields the writers actually set; everything else lives in the
 * expandable detail. Raw keys never reach the screen — every field,
 * role and status code goes through a label map.
 */
function summarize(row: AuditLogRow, language: Language, t: (s: string) => string): string | null {
  const m = row.metadata ?? {};
  const parts: string[] = [];
  const name =
    (m.contact_name as string | undefined) ??
    (m.member_name as string | undefined) ??
    (m.name as string | undefined);
  if (name) parts.push(name);
  if (typeof m.from === 'string' && typeof m.to === 'string') {
    parts.push(`${roleLabel(m.from, language)} → ${roleLabel(m.to, language)}`);
  } else if (m.role && typeof m.role === 'string') {
    parts.push(roleLabel(m.role, language));
  }
  const labelKeys = (keys: string[]) => keys.map((k) => auditFieldLabel(k, language)).join(', ');
  if (Array.isArray(m.keys) && m.keys.length > 0) {
    parts.push(labelKeys(m.keys as string[]));
  } else if (m.changes && typeof m.changes === 'object' && !Array.isArray(m.changes)) {
    const keys = Object.keys(m.changes as Record<string, unknown>);
    if (keys.length > 0) parts.push(labelKeys(keys));
  } else if (isSnapshotDiff(m)) {
    // account.registration_updated / account.contact_updated store
    // before/after snapshots — list what actually changed.
    const changed = changedSnapshotKeys(m.from as Record<string, unknown>, m.to as Record<string, unknown>);
    if (changed.length > 0) parts.push(labelKeys(changed));
  }
  if (typeof m.phone_number === 'string' && m.phone_number) parts.push(m.phone_number);
  if (typeof m.count === 'number') parts.push(`${m.count} ${t('items')}`);
  return parts.length > 0 ? parts.join(' · ') : null;
}

function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function isSnapshotDiff(m: Record<string, unknown>): boolean {
  return isPlainRecord(m.from) && isPlainRecord(m.to);
}

function changedSnapshotKeys(before: Record<string, unknown>, after: Record<string, unknown>): string[] {
  return Object.keys(after).filter(
    (k) => JSON.stringify(before[k] ?? null) !== JSON.stringify(after[k] ?? null),
  );
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

function isTimeRange(v: unknown): v is { start: string; end: string } {
  return isPlainRecord(v) && typeof v.start === 'string' && typeof v.end === 'string';
}

/** Render one metadata value for the expanded detail list. */
function formatMetaValue(value: unknown, language: Language, t: (s: string) => string): string {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'boolean') return value ? t('Yes') : t('No');
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') {
    if (ISO_DATE.test(value)) {
      const d = new Date(value);
      if (!Number.isNaN(d.getTime())) {
        return value.length > 10
          ? d.toLocaleString(language, { dateStyle: 'short', timeStyle: 'short' })
          : d.toLocaleDateString(language);
      }
    }
    return scalarLabel(value, language, t);
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return '—';
    if (value.every(isTimeRange)) return value.map((r) => `${r.start}–${r.end}`).join(', ');
    if (value.every((v) => typeof v === 'string' || typeof v === 'number')) {
      return value.map((v) => formatMetaValue(v, language, t)).join(', ');
    }
    return `${value.length} ${t('items')}`;
  }
  if (isPlainRecord(value)) {
    if ('from' in value && 'to' in value && Object.keys(value).length === 2) {
      return `${formatMetaValue(value.from, language, t)} → ${formatMetaValue(value.to, language, t)}`;
    }
    const entries = Object.entries(value);
    if (entries.length === 0) return '—';
    return entries
      .map(([k, v]) => `${keyLabel(k, language, t)}: ${formatMetaValue(v, language, t)}`)
      .join(' · ');
  }
  return String(value);
}

/** Metadata keys that are internal bookkeeping — never shown. */
const HIDDEN_META_KEYS = new Set([
  'platform_admin_user_id',
  'from_user_id',
  'to_user_id',
  'ids',
  'contact_id',
  'phone_number_id',
  'waba_id',
  'factor_type',
  'bulk',
  'truncated',
  'bytes',
]);

/** Flatten `metadata` into label/value rows for the expanded detail. */
function detailRows(
  row: AuditLogRow,
  language: Language,
  t: (s: string) => string,
): { label: string; value: string }[] {
  const m = row.metadata ?? {};
  const rows: { label: string; value: string }[] = [];
  const changes = isPlainRecord(m.changes) ? m.changes : null;
  if (changes) {
    for (const [k, v] of Object.entries(changes)) {
      rows.push({ label: auditFieldLabel(k, language), value: formatMetaValue(v, language, t) });
    }
  }
  const snapshotDiff = !changes && isSnapshotDiff(m);
  if (snapshotDiff) {
    const before = m.from as Record<string, unknown>;
    const after = m.to as Record<string, unknown>;
    for (const k of changedSnapshotKeys(before, after)) {
      rows.push({
        label: auditFieldLabel(k, language),
        value: `${formatMetaValue(before[k], language, t)} → ${formatMetaValue(after[k], language, t)}`,
      });
    }
  }
  for (const [k, v] of Object.entries(m)) {
    if (HIDDEN_META_KEYS.has(k) || k === 'changes' || k === 'keys') continue;
    if (snapshotDiff && (k === 'from' || k === 'to')) continue;
    if (k === 'to') continue;
    if (k === 'from') {
      // Scalar rename / role change: shown as one "A → B" row.
      rows.push({
        label: t('Change'),
        value: `${formatMetaValue(m.from, language, t)} → ${formatMetaValue(m.to, language, t)}`,
      });
      continue;
    }
    rows.push({ label: auditFieldLabel(k, language), value: formatMetaValue(v, language, t) });
  }
  return rows;
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
                  const summary = summarize(row, language, t);
                  // Show the short id only when nothing else identifies the
                  // entity: account-scoped rows carry the account id, MFA rows
                  // the actor's own id, and most others already name the
                  // contact / member / source in the summary.
                  const meta = row.metadata ?? {};
                  const namedInSummary = !!(meta.contact_name || meta.member_name || meta.name);
                  const shortEntityId =
                    row.entity_id &&
                    row.entity_id !== row.account_id &&
                    row.entity_id !== row.actor_user_id &&
                    !namedInSummary
                      ? row.entity_id.slice(0, 8)
                      : null;
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
                          {row.actor_name
                            ? auditActorLabel(row.actor_name, language)
                            : row.actor_user_id
                              ? t('Member')
                              : t('System')}
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-sm text-foreground">
                          {auditActionLabel(row.action, language)}
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                          {auditEntityLabel(row.entity_type, language)}
                          {shortEntityId ? (
                            <span
                              className="ml-1 font-mono text-[10px] opacity-70"
                              title={row.entity_id ?? undefined}
                              data-no-translate
                            >
                              · {shortEntityId}
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
                            <dl className="grid max-h-64 grid-cols-[max-content_1fr] gap-x-4 gap-y-1 overflow-auto rounded-md bg-muted px-3 py-2 text-[11px] leading-relaxed">
                              {detailRows(row, language, t).map((d) => (
                                <Fragment key={d.label}>
                                  <dt className="text-muted-foreground">{d.label}</dt>
                                  <dd className="break-words text-foreground" data-no-translate>
                                    {d.value}
                                  </dd>
                                </Fragment>
                              ))}
                            </dl>
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

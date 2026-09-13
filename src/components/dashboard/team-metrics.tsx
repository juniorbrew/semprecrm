"use client"

import { useCallback, useEffect, useMemo, useState } from 'react'
import { ArrowDown, ArrowUp, ArrowUpDown, Users } from 'lucide-react'

import { createClient } from '@/lib/supabase/client'
import { useAuth } from '@/hooks/use-auth'
import { useLanguage } from '@/hooks/use-language'
import { rangeLabel } from '@/lib/dashboard/i18n'
import {
  formatSeconds,
  loadTeamMetrics,
  sortTeamRows,
  type SortDirection,
  type TeamMetricsResult,
  type TeamMetricsRow,
  type TeamPeriod,
  type TeamSortKey,
} from '@/lib/dashboard/team-metrics'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { AvailabilityDot } from '@/components/layout/availability-toggle'
import { cn } from '@/lib/utils'
import { EmptyState } from './empty-state'
import { Skeleton } from './skeleton'

const PERIODS: TeamPeriod[] = [7, 30, 90]

interface Column {
  key: TeamSortKey
  label: string
  hint: string
  align: 'left' | 'right'
}

const COLUMNS: Column[] = [
  { key: 'name', label: 'Member', hint: '', align: 'left' },
  { key: 'handled', label: 'Handled', hint: 'Conversations with at least one reply from the member in the period', align: 'right' },
  { key: 'resolved', label: 'Resolved', hint: 'Conversations the member marked as resolved in the period', align: 'right' },
  { key: 'firstResponse', label: '1st response', hint: 'Average (median) time until the first reply, over conversations the member answered first', align: 'right' },
  { key: 'tasksCompleted', label: 'Tasks done', hint: 'Tasks assigned to the member completed in the period', align: 'right' },
  { key: 'openAssigned', label: 'Open now', hint: 'Conversations currently open and assigned to the member', align: 'right' },
]

interface TeamMetricsProps {
  /** Bumped by the dashboard's refresh button. */
  refreshToken?: number
}

/**
 * "Equipe" — per-member numbers for the period (spec round 2 §1).
 * Admin+ sees the whole roster; an agent or viewer only their own row.
 * Columns sort on click; the first-response cell carries a bar relative
 * to the slowest member so outliers stand out.
 */
export function TeamMetrics({ refreshToken = 0 }: TeamMetricsProps) {
  const { t, language } = useLanguage()
  const { user, accountId, canManageMembers, profileLoading } = useAuth()
  const [period, setPeriod] = useState<TeamPeriod>(30)
  const [data, setData] = useState<Record<TeamPeriod, TeamMetricsResult | null>>({
    7: null,
    30: null,
    90: null,
  })
  const [loading, setLoading] = useState(true)
  const [sortKey, setSortKey] = useState<TeamSortKey>('handled')
  const [sortDir, setSortDir] = useState<SortDirection>('desc')

  const load = useCallback(
    async (p: TeamPeriod, invalidate: boolean) => {
      if (!accountId) return
      setLoading(true)
      try {
        const result = await loadTeamMetrics(createClient(), accountId, p)
        setData((prev) =>
          invalidate ? { 7: null, 30: null, 90: null, [p]: result } : { ...prev, [p]: result },
        )
      } catch (err) {
        console.error('[dashboard] team metrics failed:', err)
        setData((prev) => ({ ...prev, [p]: { period: p, rows: [], maxFirstResponseAvgSeconds: 0 } }))
      } finally {
        setLoading(false)
      }
    },
    [accountId],
  )

  // Mount + refresh button: (re)load the current period and drop the
  // other cached buckets, which would be stale relative to it.
  useEffect(() => {
    void load(period, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- period switches load on their own
  }, [load, refreshToken])

  const handlePeriod = useCallback(
    (p: TeamPeriod) => {
      setPeriod(p)
      if (data[p] === null) void load(p, false)
    },
    [data, load],
  )

  const handleSort = useCallback(
    (key: TeamSortKey) => {
      if (key === sortKey) {
        setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
        return
      }
      setSortKey(key)
      // Times read best fastest-first; counts biggest-first.
      setSortDir(key === 'firstResponse' || key === 'name' ? 'asc' : 'desc')
    },
    [sortKey],
  )

  const result = data[period]
  const rows: TeamMetricsRow[] = useMemo(() => {
    if (!result) return []
    const visible = canManageMembers
      ? result.rows
      : result.rows.filter((r) => r.user_id === user?.id)
    return sortTeamRows(visible, sortKey, sortDir)
  }, [result, canManageMembers, user?.id, sortKey, sortDir])

  const maxAvg = result?.maxFirstResponseAvgSeconds ?? 0
  const showSkeleton = (loading && !result) || profileLoading

  return (
    <section className="flex flex-col rounded-xl border border-border bg-card" data-no-translate>
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <Users className="h-4 w-4 text-primary" aria-hidden />
            {t('Team')}
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {canManageMembers
              ? t('Per-member activity in the period')
              : t('Your activity in the period')}
          </p>
        </div>
        <div className="flex items-center gap-1 rounded-lg bg-muted/60 p-1" role="tablist" aria-label={t('Period')}>
          {PERIODS.map((p) => (
            <button
              key={p}
              type="button"
              role="tab"
              aria-selected={period === p}
              onClick={() => handlePeriod(p)}
              className={cn(
                'rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
                period === p
                  ? 'bg-secondary text-secondary-foreground'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {rangeLabel(p, language)}
            </button>
          ))}
        </div>
      </header>

      {showSkeleton ? (
        <div className="space-y-3 p-5">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-11/12" />
          <Skeleton className="h-4 w-10/12" />
        </div>
      ) : rows.length === 0 ? (
        <EmptyState
          icon={Users}
          title={t('No team activity yet')}
          hint={t('Replies, resolutions and completed tasks will show up here per member.')}
          className="m-5"
        />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="border-b border-border text-xs text-muted-foreground">
                {COLUMNS.map((col) => {
                  const active = sortKey === col.key
                  const Icon = !active ? ArrowUpDown : sortDir === 'asc' ? ArrowUp : ArrowDown
                  return (
                    <th
                      key={col.key}
                      scope="col"
                      aria-sort={active ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
                      className={cn('px-4 py-2 font-medium', col.align === 'right' ? 'text-right' : 'text-left')}
                    >
                      <button
                        type="button"
                        onClick={() => handleSort(col.key)}
                        title={col.hint ? t(col.hint) : undefined}
                        className={cn(
                          'inline-flex items-center gap-1 rounded px-1 py-0.5 transition-colors hover:text-foreground',
                          col.align === 'right' && 'flex-row-reverse',
                          active && 'text-foreground',
                        )}
                      >
                        {t(col.label)}
                        <Icon className={cn('h-3 w-3', !active && 'opacity-50')} aria-hidden />
                      </button>
                    </th>
                  )
                })}
              </tr>
            </thead>
            <tbody className="divide-y divide-border/70">
              {rows.map((row) => {
                const avg = row.firstResponseAvgSeconds
                const pct = avg !== null && maxAvg > 0 ? Math.max(4, Math.round((avg / maxAvg) * 100)) : 0
                const isSelf = row.user_id === user?.id
                return (
                  <tr key={row.user_id} data-user-id={row.user_id} className={cn(isSelf && 'bg-muted/30')}>
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-3">
                        <span className="relative shrink-0">
                          <Avatar className="size-8">
                            {row.avatar_url ? <AvatarImage src={row.avatar_url} alt={row.full_name} /> : null}
                            <AvatarFallback className="bg-primary/10 text-xs font-medium text-primary">
                              {(row.full_name || '?').charAt(0).toUpperCase()}
                            </AvatarFallback>
                          </Avatar>
                          <AvailabilityDot availability={row.availability} className="absolute -bottom-0.5 -right-0.5 size-2" />
                        </span>
                        <div className="min-w-0">
                          <p className="truncate font-medium text-foreground">
                            {row.full_name || t('Unnamed')}
                            {isSelf && (
                              <span className="ml-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                                {t('you')}
                              </span>
                            )}
                          </p>
                          <p className="truncate text-xs text-muted-foreground">
                            {row.availability === 'away' ? t('Away') : t('Available')}
                          </p>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-foreground">
                      {row.handled.toLocaleString(language)}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-foreground">
                      {row.resolved.toLocaleString(language)}
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      <div className="flex flex-col items-end gap-1">
                        <span className="whitespace-nowrap tabular-nums text-foreground">
                          {formatSeconds(avg)}
                        </span>
                        {row.firstResponseMedianSeconds !== null && (
                          <span className="whitespace-nowrap text-[11px] leading-none text-muted-foreground">
                            {t('median')} {formatSeconds(row.firstResponseMedianSeconds)}
                          </span>
                        )}
                        <span
                          className="h-1 w-28 overflow-hidden rounded-full bg-muted"
                          role="img"
                          aria-label={avg !== null ? `${t('1st response')}: ${formatSeconds(avg)}` : t('No first response yet')}
                        >
                          <span
                            className="block h-full rounded-full bg-primary/70"
                            style={{ width: `${pct}%` }}
                          />
                        </span>
                      </div>
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-foreground">
                      {row.tasksCompleted.toLocaleString(language)}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-foreground">
                      {row.openAssigned.toLocaleString(language)}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

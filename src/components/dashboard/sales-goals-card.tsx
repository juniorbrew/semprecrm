"use client"

import { useCallback, useEffect, useMemo, useState } from 'react'
import { ChevronLeft, ChevronRight, Target } from 'lucide-react'

import { createClient } from '@/lib/supabase/client'
import { useAuth } from '@/hooks/use-auth'
import { useLanguage } from '@/hooks/use-language'
import { useTeams } from '@/hooks/use-teams'
import { formatCurrency } from '@/lib/currency'
import { DEFAULT_TIMEZONE } from '@/lib/calendar/range'
import { fetchGoalProgress, goalKey, type GoalProgress } from '@/lib/sales-goals/data'
import {
  currentMonth,
  dayOfMonth,
  daysInMonth,
  monthPhase,
  paceStatus,
  percent,
  remaining,
  shiftMonth,
  type PaceStatus,
} from '@/lib/sales-goals/pace'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { EmptyState } from './empty-state'
import { SalesGoalsDialog, type Member } from './sales-goals-dialog'
import { Skeleton } from './skeleton'

const SCOPE_RANK = { account: 0, team: 1, member: 2 } as const

const CHIP: Record<Exclude<PaceStatus, 'none'>, { label: string; className: string }> = {
  hit: { label: 'Goal hit', className: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400' },
  on_pace: { label: 'On pace', className: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400' },
  behind: { label: 'Behind pace', className: 'bg-amber-500/10 text-amber-700 dark:text-amber-400' },
  missed: { label: 'Goal missed', className: 'bg-red-500/10 text-red-600 dark:text-red-400' },
}

/**
 * "Metas do mês" — company / team / seller goals with progress from the
 * exact SQL aggregate (migration 103). Owner / admin see every goal and can
 * edit from the current month on; everyone else only gets what the database
 * lets them read (company, own teams, own goal) and no edit button. Past
 * months are read-only. The dashboard gates it on the `pipelines` module.
 */
export function SalesGoalsCard({ refreshToken = 0 }: { refreshToken?: number }) {
  const { t, language } = useLanguage()
  const { accountId, user, canManageMembers, defaultCurrency, preferences, profileLoading } = useAuth()
  const timezone = preferences.business_hours?.timezone ?? DEFAULT_TIMEZONE
  const { active: teams, byId: teamById } = useTeams()

  const current = useMemo(() => currentMonth(timezone), [timezone])
  const [month, setMonth] = useState<string | null>(null)
  const shown = month ?? current
  const [rows, setRows] = useState<GoalProgress[] | null>(null)
  const [failed, setFailed] = useState(false)
  const [members, setMembers] = useState<Member[]>([])
  const [dialogOpen, setDialogOpen] = useState(false)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    if (!accountId) return
    let cancelled = false
    createClient()
      .from('profiles')
      .select('user_id, full_name')
      .eq('account_id', accountId)
      .then(({ data, error }) => {
        if (cancelled || error || !data) return
        setMembers((data as { user_id: string; full_name: string | null }[]).map((p) => ({ user_id: p.user_id, name: p.full_name || '' })))
      })
    return () => {
      cancelled = true
    }
  }, [accountId])

  useEffect(() => {
    if (!accountId) return
    let cancelled = false
    fetchGoalProgress(createClient(), accountId, shown)
      .then((r) => {
        if (cancelled) return
        setRows(r)
        setFailed(false)
      })
      .catch((err) => {
        if (cancelled) return
        console.error('[dashboard] sales goals failed:', err)
        setFailed(true)
        setRows((prev) => prev ?? [])
      })
    return () => {
      cancelled = true
    }
  }, [accountId, shown, refreshToken, tick])

  const memberName = useCallback(
    (id: string | null) => members.find((m) => m.user_id === id)?.name || t('Seller'),
    [members, t],
  )
  const labelOf = useCallback(
    (g: GoalProgress) => {
      if (g.scope === 'account') return t('Company')
      if (g.scope === 'team') return teamById.get(g.team_id ?? '')?.name ?? t('Team')
      return g.user_id === user?.id && !canManageMembers ? t('Your goal') : memberName(g.user_id)
    },
    [teamById, memberName, user?.id, canManageMembers, t],
  )

  const sorted = useMemo(
    () =>
      [...(rows ?? [])].sort(
        (a, b) =>
          SCOPE_RANK[a.scope] - SCOPE_RANK[b.scope] ||
          labelOf(a).localeCompare(labelOf(b), language) ||
          a.metric.localeCompare(b.metric),
      ),
    [rows, labelOf, language],
  )

  const phase = monthPhase(shown, current)
  const day = dayOfMonth(timezone)
  const total = daysInMonth(shown)
  const editable = canManageMembers && shown === current
  const money = (n: number) => formatCurrency(n, defaultCurrency)
  const count = (n: number) => `${n.toLocaleString(language)} ${n === 1 ? t('deal') : t('deals')}`
  const fmt = (g: GoalProgress, n: number) => (g.metric === 'won_value' ? money(n) : count(n))

  const monthLabel = useMemo(() => {
    const [y, m] = shown.split('-').map(Number)
    const s = new Intl.DateTimeFormat(language, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(Date.UTC(y, m - 1, 1))
    return s.charAt(0).toUpperCase() + s.slice(1)
  }, [shown, language])

  const loading = profileLoading || rows === null
  // A seller with nothing assigned does not need an empty box on the dashboard.
  if (!loading && !canManageMembers && rows!.length === 0 && shown === current) return null

  return (
    <section className="flex flex-col rounded-xl border border-border bg-card" data-no-translate>
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <Target className="h-4 w-4 text-primary" aria-hidden />
            {t('Monthly goals')}
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {phase === 'past' ? t('Read-only: this month is closed') : t('Closed deals in the month against the goal')}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1 rounded-lg bg-muted/60 p-1">
            <button
              type="button"
              aria-label={t('Previous month')}
              onClick={() => setMonth(shiftMonth(shown, -1))}
              className="rounded-md p-1 text-muted-foreground transition-colors hover:text-foreground"
            >
              <ChevronLeft className="h-4 w-4" aria-hidden />
            </button>
            <span className="min-w-28 text-center text-xs font-medium text-foreground" aria-live="polite">
              {monthLabel}
            </span>
            <button
              type="button"
              aria-label={t('Next month')}
              disabled={shown >= current}
              onClick={() => setMonth(shiftMonth(shown, 1))}
              className="rounded-md p-1 text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40"
            >
              <ChevronRight className="h-4 w-4" aria-hidden />
            </button>
          </div>
          {editable && (
            <Button size="sm" variant="outline" onClick={() => setDialogOpen(true)}>
              {t('Set goals')}
            </Button>
          )}
        </div>
      </header>

      {loading ? (
        <div className="space-y-3 p-5">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-11/12" />
        </div>
      ) : failed && sorted.length === 0 ? (
        <p className="p-5 text-sm text-muted-foreground">{t('Could not load the goals.')}</p>
      ) : sorted.length === 0 ? (
        <EmptyState
          icon={Target}
          title={shown === current ? t('No goals yet') : t('No goals in this month')}
          hint={
            shown === current && canManageMembers
              ? t('Set a monthly goal for the company, a team or a seller and follow the progress here.')
              : undefined
          }
          className="m-5"
        />
      ) : (
        <ul className="divide-y divide-border/70">
          {sorted.map((g) => {
            const pct = percent(g)
            const status = paceStatus(g, phase, day, total)
            const chip = status === 'none' ? null : CHIP[status]
            const label = labelOf(g)
            const metricLabel = g.metric === 'won_value' ? t('Won value') : t('Won deals')
            return (
              <li key={goalKey(g)} className="px-5 py-3">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                  <p className="min-w-0 truncate text-sm font-medium text-foreground">
                    {label} <span className="text-xs font-normal text-muted-foreground">· {metricLabel}</span>
                  </p>
                  {chip && (
                    <span className={cn('rounded-full px-2 py-0.5 text-[11px] font-medium', chip.className)}>{t(chip.label)}</span>
                  )}
                </div>
                <div
                  role="progressbar"
                  aria-label={`${label} · ${metricLabel}`}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.min(pct, 100)}
                  aria-valuetext={`${pct}%`}
                  className="mt-2 h-2 overflow-hidden rounded-full bg-muted"
                >
                  <div
                    className={cn('h-full rounded-full', status === 'missed' ? 'bg-red-500/70' : status === 'behind' ? 'bg-amber-500' : 'bg-primary')}
                    style={{ width: `${Math.min(pct, 100)}%` }}
                  />
                </div>
                <div className="mt-1.5 flex flex-wrap items-center justify-between gap-x-3 text-xs text-muted-foreground tabular-nums">
                  <span>
                    {fmt(g, g.achieved)} {t('of')} {fmt(g, g.target)} ({pct}%)
                  </span>
                  {remaining(g) > 0 && (
                    <span>
                      {t('short by')} {fmt(g, remaining(g))}
                    </span>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      )}

      {editable && accountId && (
        <SalesGoalsDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          accountId={accountId}
          month={current}
          goals={rows ?? []}
          teams={teams}
          members={members}
          labelOf={labelOf}
          format={fmt}
          onChanged={() => setTick((n) => n + 1)}
        />
      )}
    </section>
  )
}

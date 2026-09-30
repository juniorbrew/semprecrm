"use client"

import { useCallback, useEffect, useState } from 'react'

import { useAuth } from '@/hooks/use-auth'
import { useLanguage } from '@/hooks/use-language'
import { createClient } from '@/lib/supabase/client'
import { rangeLabel } from '@/lib/dashboard/i18n'
import { loadResolutionTime, type ResolutionTimeResult } from '@/lib/dashboard/resolution-time'
import { formatSeconds, type TeamPeriod } from '@/lib/dashboard/team-metrics'
import { cn } from '@/lib/utils'
import { Skeleton } from './skeleton'

const PERIODS: TeamPeriod[] = [7, 30, 90]

/**
 * Average time from the first message to "Resolvida", next to the
 * first-response chart. One number, the median as a footnote, and the
 * same 7 / 30 / 90 day switch the Team block uses.
 */
export function ResolutionTimeCard({ refreshToken = 0 }: { refreshToken?: number }) {
  const { t, language } = useLanguage()
  const { accountId } = useAuth()
  const [period, setPeriod] = useState<TeamPeriod>(30)
  const [data, setData] = useState<Partial<Record<TeamPeriod, ResolutionTimeResult>>>({})
  const [loading, setLoading] = useState(true)

  const load = useCallback(
    async (p: TeamPeriod, invalidate: boolean) => {
      if (!accountId) return
      setLoading(true)
      try {
        const result = await loadResolutionTime(createClient(), accountId, p)
        setData((prev) => (invalidate ? { [p]: result } : { ...prev, [p]: result }))
      } catch (err) {
        console.error('[dashboard] resolution time failed:', err)
        setData((prev) => ({ ...prev, [p]: { period: p, count: 0, avgSeconds: null, medianSeconds: null } }))
      } finally {
        setLoading(false)
      }
    },
    [accountId],
  )

  useEffect(() => {
    void load(period, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- period switches load on their own
  }, [load, refreshToken])

  const handlePeriod = (p: TeamPeriod) => {
    setPeriod(p)
    if (!data[p]) void load(p, false)
  }

  const result = data[period]

  return (
    <section className="flex h-full flex-col rounded-xl border border-border bg-card" data-no-translate>
      <header className="flex flex-wrap items-start justify-between gap-3 px-5 pt-4">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-foreground">{t('Average resolution time')}</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">{t('From the first message to resolved')}</p>
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
                period === p ? 'bg-secondary text-secondary-foreground' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {rangeLabel(p, language)}
            </button>
          ))}
        </div>
      </header>

      <div className="flex flex-1 flex-col justify-center px-5 pb-5 pt-4">
        {loading && !result ? (
          <Skeleton className="h-10 w-40" />
        ) : !result || result.count === 0 ? (
          <p className="text-sm text-muted-foreground">{t('No conversations resolved in this period.')}</p>
        ) : (
          <>
            <p className="text-3xl font-semibold tabular-nums text-foreground">{formatSeconds(result.avgSeconds)}</p>
            <p className="mt-1.5 text-xs text-muted-foreground tabular-nums">
              {t('median')} {formatSeconds(result.medianSeconds)} · {result.count}{' '}
              {result.count === 1 ? t('conversation resolved') : t('conversations resolved')}
            </p>
          </>
        )}
      </div>
    </section>
  )
}

"use client"

import { useCallback, useEffect, useState } from 'react'

import { useAuth } from '@/hooks/use-auth'
import { useLanguage } from '@/hooks/use-language'
import { createClient } from '@/lib/supabase/client'
import { rangeLabel } from '@/lib/dashboard/i18n'
import { loadSlaCompliance, type SlaComplianceResult } from '@/lib/dashboard/sla-compliance'
import type { TeamPeriod } from '@/lib/dashboard/team-metrics'
import { slaCopy } from '@/lib/support/sla'
import { cn } from '@/lib/utils'
import { Skeleton } from './skeleton'

const PERIODS: TeamPeriod[] = [7, 30, 90]

/** "Cumprimento dos prazos": one number and one line; shown only when the account has deadlines. */
export function SlaComplianceCard({ refreshToken = 0 }: { refreshToken?: number }) {
  const { language } = useLanguage()
  const copy = slaCopy(language)
  const pt = language === 'pt-BR'
  const { accountId } = useAuth()
  const [period, setPeriod] = useState<TeamPeriod>(30)
  const [data, setData] = useState<Partial<Record<TeamPeriod, SlaComplianceResult>>>({})
  const [loading, setLoading] = useState(true)

  const load = useCallback(
    async (p: TeamPeriod, invalidate: boolean) => {
      if (!accountId) return
      setLoading(true)
      try {
        const result = await loadSlaCompliance(createClient(), accountId, p)
        setData((prev) => (invalidate ? { [p]: result } : { ...prev, [p]: result }))
      } catch (err) {
        console.error('[dashboard] SLA compliance failed:', err)
        setData((prev) => ({ ...prev, [p]: { period: p, met: 0, missed: 0, percent: null } }))
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

  const result = data[period]
  const total = result ? result.met + result.missed : 0

  return (
    <section className="flex flex-col rounded-xl border border-border bg-card" data-no-translate data-testid="sla-compliance">
      <header className="flex flex-wrap items-start justify-between gap-3 px-5 pt-4">
        <h2 className="text-sm font-semibold text-foreground">{copy.compliance}</h2>
        <div className="flex items-center gap-1 rounded-lg bg-muted/60 p-1" role="tablist" aria-label={pt ? 'Período' : 'Period'}>
          {PERIODS.map((p) => (
            <button
              key={p}
              type="button"
              role="tab"
              aria-selected={period === p}
              onClick={() => {
                setPeriod(p)
                if (!data[p]) void load(p, false)
              }}
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
      <div className="px-5 pb-5 pt-4">
        {loading && !result ? (
          <Skeleton className="h-10 w-28" />
        ) : !result || result.percent === null ? (
          <p className="text-sm text-muted-foreground">
            {pt ? 'Nenhum prazo avaliado neste período.' : 'No deadlines judged in this period.'}
          </p>
        ) : (
          <>
            <p className="text-3xl font-semibold tabular-nums text-foreground">{result.percent}%</p>
            <p className="mt-1.5 text-xs text-muted-foreground tabular-nums">
              {pt ? `${result.met} de ${total} prazos cumpridos` : `${result.met} of ${total} deadlines met`}
            </p>
          </>
        )}
      </div>
    </section>
  )
}

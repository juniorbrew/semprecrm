"use client"

import { Clock } from 'lucide-react'
import type { ResponseTimeSummary } from '@/lib/dashboard/types'
import { dowShort, minutesAxisLabel, minutesLabel, targetLabel } from '@/lib/dashboard/i18n'
import { useLanguage } from '@/hooks/use-language'
import { BarChart } from '@/components/tremor/bar-chart'
import { EmptyState } from './empty-state'
import { Skeleton } from './skeleton'

interface ResponseTimeChartProps {
  data: ResponseTimeSummary | null
  loading: boolean
  /** Minutes. Surfaced as a "target" pill in the header. The
   *  hand-rolled SVG version drew this as a horizontal dashed
   *  line on the chart; Tremor BarChart doesn't expose Recharts
   *  primitives, so we promote it to the header for now. A
   *  follow-up can introduce an overlay or extend the vendored
   *  BarChart with a `referenceLines` prop. */
  thresholdMinutes?: number
}

export function ResponseTimeChart({
  data,
  loading,
  thresholdMinutes = 5,
}: ResponseTimeChartProps) {
  const { t, language } = useLanguage()
  const hasData = data?.buckets.some((b) => b.avgMinutes != null) ?? false

  // Single category, single colour — the data is "average minutes
  // per weekday". Tremor expects categories as the second tuple in
  // the row object, so we shape the buckets into
  // `{ day: 'seg', 'Média em minutos': 4.2 }` rows below. The category
  // name doubles as the tooltip label, hence it is localised.
  const category = t('Avg minutes')
  const days = dowShort(language)

  // Map buckets → Tremor rows. Null `avgMinutes` (no samples)
  // collapses to 0; the chart will render an empty slot for it.
  // We attach `samples` on the row so a future customTooltip can
  // surface "no samples" copy without losing the data shape.
  const chartData =
    data?.buckets.map((b, i) => ({
      day: days[i],
      [category]: b.avgMinutes ?? 0,
      samples: b.samples,
    })) ?? []

  return (
    <section className="h-full rounded-xl border border-border bg-card">
      <header className="flex items-center justify-between gap-3 border-b border-border px-5 py-4">
        <div>
          <h2 className="text-sm font-semibold text-foreground">
            {t('Average First Response Time')}
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {t("Minutes to reply to a customer's first unreplied message, by weekday")}
          </p>
        </div>
        {/* shrink-0 + nowrap: at 1024px the header used to squeeze this
            block and break "meta 5 min" / "Semana passada: 5,5 min" mid-
            phrase; the subtitle on the left is what should wrap instead. */}
        <div className="flex shrink-0 items-center gap-3 whitespace-nowrap text-right text-xs">
          {thresholdMinutes > 0 && (
            <span className="rounded-full border border-rose-500/40 bg-rose-500/10 px-2 py-0.5 font-medium text-rose-500 tabular-nums dark:text-rose-300">
              {targetLabel(thresholdMinutes, language)}
            </span>
          )}
          {data && (data.thisWeekAvg != null || data.lastWeekAvg != null) && (
            <div>
              <div className="text-muted-foreground">
                {t('This week:')}{' '}
                <span className="font-medium text-foreground tabular-nums">
                  {minutesLabel(data.thisWeekAvg, language)}
                </span>
              </div>
              <div className="text-muted-foreground">
                {t('Last week:')}{' '}
                <span className="tabular-nums">{minutesLabel(data.lastWeekAvg, language)}</span>
              </div>
            </div>
          )}
        </div>
      </header>

      <div className="p-5">
        {loading || !data ? (
          <Skeleton className="h-[260px] w-full" />
        ) : !hasData ? (
          <EmptyState
            icon={Clock}
            title={t('No replies recorded yet')}
            hint={t('This chart fills in as you reply to customer messages.')}
          />
        ) : (
          <BarChart
            data={chartData}
            index="day"
            categories={[category]}
            // 'violet' maps to Tailwind's `fill-violet-500` — matches
            // the brand accent the hand-rolled bars used (#7c3aed).
            colors={['violet']}
            valueFormatter={(value) => minutesAxisLabel(value, language)}
            showLegend={false}
            // Wide enough for "12,5 min" at the axis font size so the
            // top tick never clips (it used to render as "2.0m").
            yAxisWidth={64}
            // Compact height so the chart sits well inside the card
            // without dominating the row alongside the donut + activity feed.
            className="h-[260px]"
          />
        )}
      </div>
    </section>
  )
}

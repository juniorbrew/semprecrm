"use client"

import { useCallback, useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useAuth } from '@/hooks/use-auth'
import { useLanguage } from '@/hooks/use-language'
import { formatCurrency } from '@/lib/currency'
import {
  MessageSquare,
  UserPlus,
  DollarSign,
  Send,
  RefreshCw,
} from 'lucide-react'

import {
  loadActivity,
  loadConversationsSeries,
  loadMetrics,
  loadPipelineDonut,
  loadResponseTime,
} from '@/lib/dashboard/queries'
import { deltaVsYesterday, openDealsCount, updatedAtLabel } from '@/lib/dashboard/i18n'
import type {
  ActivityItem,
  ConversationsSeriesPoint,
  MetricsBundle,
  PipelineDonutData,
  ResponseTimeSummary,
} from '@/lib/dashboard/types'

import { MetricCard } from '@/components/dashboard/metric-card'
import { SkeletonCard } from '@/components/dashboard/skeleton'
import { QuickActions } from '@/components/dashboard/quick-actions'
import { ConversationsChart } from '@/components/dashboard/conversations-chart'
import { PipelineDonut } from '@/components/dashboard/pipeline-donut'
import { ResponseTimeChart } from '@/components/dashboard/response-time-chart'
import { ActivityFeed } from '@/components/dashboard/activity-feed'
import { cn } from '@/lib/utils'

type RangeDays = 7 | 30 | 90

export default function DashboardPage() {
  const { defaultCurrency } = useAuth()
  const { t, language } = useLanguage()
  const [metrics, setMetrics] = useState<MetricsBundle | null>(null)
  const [metricsLoading, setMetricsLoading] = useState(true)

  const [range, setRange] = useState<RangeDays>(30)
  // Keep a cache per range so switching tabs doesn't re-fetch what we
  // already have. Ranges the user hasn't opened yet stay null and
  // trigger a fetch on first view.
  const [series, setSeries] = useState<Record<RangeDays, ConversationsSeriesPoint[] | null>>({
    7: null,
    30: null,
    90: null,
  })
  const [seriesLoading, setSeriesLoading] = useState(true)

  const [pipeline, setPipeline] = useState<PipelineDonutData | null>(null)
  const [pipelineLoading, setPipelineLoading] = useState(true)

  const [responseTime, setResponseTime] = useState<ResponseTimeSummary | null>(null)
  const [responseTimeLoading, setResponseTimeLoading] = useState(true)

  const [activity, setActivity] = useState<ActivityItem[] | null>(null)
  const [activityLoading, setActivityLoading] = useState(true)

  // "Atualizado às 14:32" in the header + a manual refresh. `updatedAt`
  // is stamped once every widget has settled; `refreshing` only guards
  // the button, existing data stays on screen while new data loads.
  // It starts `true` because the mount fetch *is* the first refresh —
  // that way `loadAll` never has to set it synchronously from the
  // effect (react-hooks/set-state-in-effect); only the button's click
  // handler flips it back on.
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null)
  const [refreshing, setRefreshing] = useState(true)

  const loadAll = useCallback((seriesRange: RangeDays) => {
    const db = createClient()

    // Kick everything off in parallel. Each block has its own
    // setState + finally so a slow query doesn't hold up faster
    // sections — each widget shows its own skeleton independently.
    const jobs = [
      loadMetrics(db)
        .then((m) => setMetrics(m))
        .catch((err) => console.error('[dashboard] metrics failed:', err))
        .finally(() => setMetricsLoading(false)),

      // A refresh invalidates the other range buckets — they'd be
      // stale relative to the one we just fetched.
      loadConversationsSeries(db, seriesRange)
        .then((s) => setSeries({ 7: null, 30: null, 90: null, [seriesRange]: s }))
        .catch((err) => console.error('[dashboard] series failed:', err))
        .finally(() => setSeriesLoading(false)),

      loadPipelineDonut(db)
        .then((p) => setPipeline(p))
        .catch((err) => console.error('[dashboard] pipeline failed:', err))
        .finally(() => setPipelineLoading(false)),

      loadResponseTime(db)
        .then((r) => setResponseTime(r))
        .catch((err) => console.error('[dashboard] response time failed:', err))
        .finally(() => setResponseTimeLoading(false)),

      // Fetch up to 50 so the biggest page-size option in the feed
      // (50 rows) is already in memory — switching sizes then becomes
      // a pure client-side slice with no extra round trip.
      loadActivity(db, 50)
        .then((a) => setActivity(a))
        .catch((err) => console.error('[dashboard] activity failed:', err))
        .finally(() => setActivityLoading(false)),
    ]

    void Promise.allSettled(jobs).then(() => {
      setUpdatedAt(new Date())
      setRefreshing(false)
    })
  }, [])

  useEffect(() => {
    loadAll(30)
  }, [loadAll])

  const handleRefresh = useCallback(() => {
    setRefreshing(true)
    loadAll(range)
  }, [loadAll, range])

  // Range switch handler — kept in an event callback (not an effect)
  // so the setState calls stay out of the react-hooks/set-state-in-effect
  // rule's way. The cached bucket check means switching back to a
  // previously-viewed range is instant and doesn't re-fetch.
  const handleRangeChange = useCallback(
    (r: RangeDays) => {
      setRange(r)
      if (series[r] !== null) return
      setSeriesLoading(true)
      const db = createClient()
      loadConversationsSeries(db, r)
        .then((s) => setSeries((prev) => ({ ...prev, [r]: s })))
        .catch((err) => console.error('[dashboard] series failed:', err))
        .finally(() => setSeriesLoading(false))
    },
    [series],
  )

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-foreground">{t('Dashboard')}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t('Live analytics across conversations, contacts, deals, broadcasts, and automations.')}
          </p>
        </div>
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          {updatedAt && (
            <span className="tabular-nums">{updatedAtLabel(updatedAt, language)}</span>
          )}
          <button
            type="button"
            onClick={handleRefresh}
            disabled={refreshing}
            aria-label={t('Refresh dashboard data')}
            className={cn(
              'flex items-center gap-1.5 rounded-lg border border-border bg-card px-2.5 py-1.5 font-medium text-foreground transition-colors hover:bg-muted/60',
              refreshing && 'cursor-wait opacity-60',
            )}
          >
            <RefreshCw className={cn('h-3.5 w-3.5', refreshing && 'animate-spin')} aria-hidden />
            {t('Refresh')}
          </button>
        </div>
      </div>

      {/* Metric cards. 2x2 until xl: at 1024px a 4-up row leaves ~168px
          per card, the titles wrap to two/three lines and the four
          baselines stop lining up. */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {metricsLoading || !metrics ? (
          Array.from({ length: 4 }).map((_, i) => <SkeletonCard key={i} />)
        ) : (
          <>
            <MetricCard
              title={t('Active Conversations')}
              value={metrics.activeConversations.current.toLocaleString(language)}
              icon={MessageSquare}
              delta={{
                // `previous` here is already the delta in NEW open
                // conversations today vs yesterday (see loadMetrics).
                sign: metrics.activeConversations.previous,
                label: deltaVsYesterday(metrics.activeConversations.previous, language),
              }}
            />
            <MetricCard
              title={t('New Contacts Today')}
              value={metrics.newContactsToday.current.toLocaleString(language)}
              icon={UserPlus}
              delta={{
                sign:
                  metrics.newContactsToday.current - metrics.newContactsToday.previous,
                label: deltaVsYesterday(
                  metrics.newContactsToday.current - metrics.newContactsToday.previous,
                  language,
                ),
              }}
            />
            <MetricCard
              title={t('Open Deals Value')}
              value={formatCurrency(metrics.openDealsValue, defaultCurrency)}
              icon={DollarSign}
              subtitle={openDealsCount(metrics.openDealsCount, language)}
            />
            <MetricCard
              title={t('Messages Sent Today')}
              value={metrics.messagesSentToday.current.toLocaleString(language)}
              icon={Send}
              delta={{
                sign:
                  metrics.messagesSentToday.current - metrics.messagesSentToday.previous,
                label: deltaVsYesterday(
                  metrics.messagesSentToday.current - metrics.messagesSentToday.previous,
                  language,
                ),
              }}
            />
          </>
        )}
      </div>

      {/* Quick actions */}
      <QuickActions />

      {/* Charts row */}
      {/* items-stretch (the grid default) stretches the two columns to
          match the tallest sibling; adding h-full on each wrapper and
          on the inner panels makes both cards actually fill that
          stretched height so their rounded borders line up. Without
          this, the pipeline card rendered at its natural (shorter)
          height while the line chart drove the row height. */}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-5">
        <div className="h-full xl:col-span-3">
          <ConversationsChart
            series={series}
            loading={seriesLoading}
            range={range}
            onRangeChange={handleRangeChange}
          />
        </div>
        <div className="h-full xl:col-span-2">
          <PipelineDonut
            data={pipeline}
            loading={pipelineLoading}
            currency={defaultCurrency}
          />
        </div>
      </div>

      {/* Response time */}
      <ResponseTimeChart data={responseTime} loading={responseTimeLoading} />

      {/* Activity feed */}
      <ActivityFeed items={activity} loading={activityLoading} />
    </div>
  )
}

"use client"

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { ArrowRight, Clock, Radar, Snowflake, UserX } from 'lucide-react'

import { createClient } from '@/lib/supabase/client'
import { useAuth } from '@/hooks/use-auth'
import { useLanguage } from '@/hooks/use-language'
import {
  countRadar,
  formatWaitingAge,
  type RadarConversation,
  type RadarKey,
} from '@/lib/radar/classify'
import { cn } from '@/lib/utils'
import { Skeleton } from './skeleton'

interface RadarCardProps {
  /** Bumped by the dashboard's refresh button. */
  refreshToken?: number
}

const TILE_META: Record<
  RadarKey,
  { icon: typeof Clock; label: string; tone: string; toneActive: string }
> = {
  waiting: {
    icon: Clock,
    label: 'Waiting',
    tone: 'text-red-500 dark:text-red-400',
    toneActive: 'bg-red-500/10',
  },
  unassigned: {
    icon: UserX,
    label: 'No owner',
    tone: 'text-amber-600 dark:text-amber-400',
    toneActive: 'bg-amber-500/10',
  },
  cooling: {
    icon: Snowflake,
    label: 'Cooling',
    tone: 'text-sky-600 dark:text-sky-400',
    toneActive: 'bg-sky-500/10',
  },
}

/**
 * "Radar" — conversations at risk right now: waiting past the SLA,
 * open without an owner, or cooling after our last message. Same
 * classifier as the inbox chips (`@/lib/radar/classify`), so the
 * counters here and the chip counts there always agree. Each tile deep-
 * links into the inbox pre-filtered on that bucket.
 */
export function RadarCard({ refreshToken = 0 }: RadarCardProps) {
  const { t, language } = useLanguage()
  const { accountId, preferences } = useAuth()
  const [rows, setRows] = useState<RadarConversation[] | null>(null)
  const [now, setNow] = useState(() => Date.now())

  const load = useCallback(async () => {
    if (!accountId) return
    try {
      const { data, error } = await createClient()
        .from('conversations')
        .select('status, assigned_agent_id, last_customer_message_at, last_agent_message_at')
        .eq('account_id', accountId)
        .neq('status', 'closed')
      if (error) throw error
      setRows((data ?? []) as RadarConversation[])
      setNow(Date.now())
    } catch (err) {
      console.error('[dashboard] radar failed:', err)
      setRows([])
    }
  }, [accountId])

  useEffect(() => {
    void load()
  }, [load, refreshToken])

  // The buckets are time-based; tick every minute so a conversation that
  // just crossed the SLA shows up without a refetch.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(id)
  }, [])

  const counts = useMemo(
    () => (rows ? countRadar(rows, preferences, now) : null),
    [rows, preferences, now],
  )

  const loading = rows === null
  const total = counts ? counts.waiting + counts.unassigned + counts.cooling : 0

  const oldest = counts?.oldestWaitingSince
    ? `${t('Oldest waiting')}: ${formatWaitingAge(counts.oldestWaitingSince, now, language)}`
    : counts?.oldestCoolingSince
      ? `${t('Oldest cooling')}: ${formatWaitingAge(counts.oldestCoolingSince, now, language)}`
      : null

  return (
    <section className="flex h-full flex-col rounded-xl border border-border bg-card" data-no-translate>
      <header className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <Radar className="h-4 w-4 text-primary" aria-hidden />
            {t('Radar')}
          </h2>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {loading
              ? t('Conversations at risk right now')
              : total === 0
                ? t('Nothing at risk — everyone has been answered.')
                : oldest ?? t('Conversations at risk right now')}
          </p>
        </div>
        <Link
          href="/inbox"
          className="inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-primary transition-colors hover:bg-primary/10"
        >
          {t('Open inbox')}
          <ArrowRight className="h-3.5 w-3.5" aria-hidden />
        </Link>
      </header>

      <div className="grid flex-1 grid-cols-3 gap-2 p-4">
        {(Object.keys(TILE_META) as RadarKey[]).map((key) => {
          const meta = TILE_META[key]
          const Icon = meta.icon
          const value = counts ? counts[key] : 0
          const hot = value > 0
          return (
            <Link
              key={key}
              href={`/inbox?radar=${key}`}
              aria-label={`${t(meta.label)}: ${value}`}
              className={cn(
                'group flex flex-col justify-between rounded-lg border border-border/70 p-3 transition-colors hover:border-primary/40 hover:bg-muted/40',
                hot && meta.toneActive,
              )}
            >
              <span className={cn('flex items-center gap-1.5 text-[11px] font-medium', hot ? meta.tone : 'text-muted-foreground')}>
                <Icon className="h-3.5 w-3.5" aria-hidden />
                <span className="truncate">{t(meta.label)}</span>
              </span>
              {loading ? (
                <Skeleton className="mt-2 h-7 w-10" />
              ) : (
                <span
                  className={cn(
                    'mt-2 text-2xl font-bold leading-none tabular-nums',
                    hot ? 'text-foreground' : 'text-muted-foreground',
                  )}
                >
                  {value.toLocaleString(language)}
                </span>
              )}
            </Link>
          )
        })}
      </div>

      <p className="px-4 pb-3 text-[11px] text-muted-foreground">
        {t('SLA')}: {preferences.inbox_sla_minutes} min · {t('Cooling after')}{' '}
        {preferences.cooling_hours} h ·{' '}
        <Link href="/settings?tab=inbox" className="underline-offset-2 hover:text-foreground hover:underline">
          {t('Adjust')}
        </Link>
      </p>
    </section>
  )
}

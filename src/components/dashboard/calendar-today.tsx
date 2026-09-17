"use client"

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { ArrowRight, CalendarDays, MapPin, Plus } from 'lucide-react'

import { createClient } from '@/lib/supabase/client'
import { useAuth } from '@/hooks/use-auth'
import { useLanguage } from '@/hooks/use-language'
import {
  addDaysIn,
  formatEventRange,
  listMyEventsInRange,
  sortUpcomingFirst,
  startOfDayIn,
  type CalendarEvent,
} from '@/lib/calendar'
import { EventDrawer, eventColor, useCalendarRealtime, useCalendarTimezone } from '@/components/calendar'
import { EmptyState } from './empty-state'
import { Skeleton } from './skeleton'

/** Rows shown on the card; the rest lives behind "Ver agenda". */
const MAX_ROWS = 6

interface CalendarTodayProps {
  /** Bumped by the dashboard's refresh button. */
  refreshToken?: number
}

/**
 * "Hoje na agenda" — the signed-in user's appointments of today
 * (owner or attendee) in the account timezone, the ones still to
 * come first, with a link to /agenda. Kept live through the calendar
 * realtime channel.
 */
export function CalendarToday({ refreshToken = 0 }: CalendarTodayProps) {
  const { t, language } = useLanguage()
  const { user, accountId } = useAuth()
  const tz = useCalendarTimezone()
  const [events, setEvents] = useState<CalendarEvent[] | null>(null)
  const [drawerEvent, setDrawerEvent] = useState<CalendarEvent | null>(null)
  const [drawerOpen, setDrawerOpen] = useState(false)
  // Minute tick so "already over" rows fade as the day goes on.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(id)
  }, [])

  const userId = user?.id ?? null

  const load = useCallback(async () => {
    if (!userId) return
    try {
      const from = startOfDayIn(new Date(), tz)
      const to = addDaysIn(from, 1, tz)
      const rows = await listMyEventsInRange(createClient(), { accountId, userId, from, to })
      setEvents(sortUpcomingFirst(rows))
    } catch (err) {
      console.error('[dashboard] calendar today failed:', err)
      setEvents([])
    }
  }, [userId, accountId, tz])

  // `refreshToken` only re-runs the fetch; the setState calls happen
  // inside `load`'s awaited callbacks, never synchronously in the effect.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load()
  }, [load, refreshToken])

  useCalendarRealtime(() => void load())

  const visible = useMemo(() => (events ?? []).slice(0, MAX_ROWS), [events])
  const hidden = (events?.length ?? 0) - visible.length
  const loading = events === null

  return (
    <section className="flex h-full flex-col rounded-xl border border-border bg-card">
      <header className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
        <div>
          <h2 className="text-sm font-semibold text-foreground">{t('Today on the calendar')}</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {loading
              ? t('Your appointments for today')
              : `${events!.length} ${t(events!.length === 1 ? 'appointment' : 'appointments')}`}
          </p>
        </div>
        <Link
          href="/agenda"
          className="inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-primary transition-colors hover:bg-primary/10"
        >
          {t('Open calendar')}
          <ArrowRight className="h-3.5 w-3.5" aria-hidden />
        </Link>
      </header>

      <div className="flex flex-1 flex-col p-4">
        {loading ? (
          <div className="space-y-2">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : visible.length === 0 ? (
          <EmptyState
            icon={CalendarDays}
            title={t('Nothing scheduled today')}
            hint={t('Appointments you own or attend today show up here.')}
          />
        ) : (
          <>
            <ul className="divide-y divide-border/60 overflow-hidden rounded-lg border border-border/60">
              {visible.map((ev) => {
                const over = new Date(ev.ends_at).getTime() <= now
                return (
                  <li key={ev.id} className={over ? 'opacity-60' : undefined}>
                    <button
                      type="button"
                      onClick={() => {
                        setDrawerEvent(ev)
                        setDrawerOpen(true)
                      }}
                      className="flex w-full items-start gap-3 px-3 py-2 text-left transition-colors hover:bg-muted/50"
                    >
                      <span
                        className="mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full"
                        style={{ backgroundColor: eventColor(ev) }}
                        aria-hidden
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-foreground">{ev.title}</span>
                        <span className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11px] text-muted-foreground">
                          <span className="tabular-nums">
                            {formatEventRange(ev, language, tz, { allDayLabel: t('All day') })}
                          </span>
                          {ev.location && (
                            <span className="inline-flex min-w-0 items-center gap-1">
                              <MapPin className="h-3 w-3 shrink-0" />
                              <span className="truncate">{ev.location}</span>
                            </span>
                          )}
                        </span>
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
            {hidden > 0 && (
              <p className="mt-2 text-[11px] text-muted-foreground">
                +{hidden} {t(hidden === 1 ? 'more appointment' : 'more appointments')}
              </p>
            )}
          </>
        )}
        <div className="mt-auto pt-3">
          <button
            type="button"
            onClick={() => {
              setDrawerEvent(null)
              setDrawerOpen(true)
            }}
            className="inline-flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            <Plus className="h-3.5 w-3.5" aria-hidden />
            {t('New appointment')}
          </button>
        </div>
      </div>

      <EventDrawer
        open={drawerOpen}
        onOpenChange={setDrawerOpen}
        event={drawerEvent}
        onCreated={() => void load()}
        onUpdated={() => void load()}
        onDeleted={(id) => setEvents((prev) => (prev ? prev.filter((x) => x.id !== id) : prev))}
      />
    </section>
  )
}

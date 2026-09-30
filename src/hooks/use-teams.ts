'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'

import { useAuth } from '@/hooks/use-auth'
import { createClient } from '@/lib/supabase/client'
import { activeTeams, listTeams, type Team } from '@/lib/support/teams'

const CHANGED = 'semprecrm:teams-changed'

/** Call after creating / renaming / archiving a team so open inboxes refetch. */
export function notifyTeamsChanged() {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(CHANGED))
}

/** The account's teams (archived included, for lookups); `active` = pickable ones. */
export function useTeams() {
  const { accountId } = useAuth()
  const [all, setAll] = useState<Team[]>([])
  const [tick, setTick] = useState(0)

  useEffect(() => {
    const onChange = () => setTick((n) => n + 1)
    window.addEventListener(CHANGED, onChange)
    return () => window.removeEventListener(CHANGED, onChange)
  }, [])

  useEffect(() => {
    if (!accountId) return
    const supabase = createClient()
    const channel = supabase
      // Unique topic per mount: several components use this hook at once.
      .channel(`teams:${accountId}:${Math.random().toString(36).slice(2)}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'teams', filter: `account_id=eq.${accountId}` }, () =>
        setTick((n) => n + 1),
      )
      .subscribe()
    return () => {
      supabase.removeChannel(channel)
    }
  }, [accountId])

  useEffect(() => {
    if (!accountId) return
    let cancelled = false
    listTeams(createClient(), accountId)
      .then((rows) => {
        if (!cancelled) setAll(rows)
      })
      .catch((err) => console.error('Failed to load teams:', err))
    return () => {
      cancelled = true
    }
  }, [accountId, tick])

  const refresh = useCallback(() => setTick((n) => n + 1), [])
  const active = useMemo(() => activeTeams(all), [all])
  const byId = useMemo(() => new Map(all.map((t) => [t.id, t])), [all])
  return { all, active, byId, refresh }
}

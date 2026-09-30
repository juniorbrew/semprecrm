'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'

import { useAuth } from '@/hooks/use-auth'
import { createClient } from '@/lib/supabase/client'
import { listCategories } from '@/lib/support/categories'
import { activeCategories, categoryMap, type ConversationCategory } from '@/lib/support/model'

const CHANGED = 'semprecrm:categories-changed'

/** Call after creating / editing / archiving a category so open inboxes refetch. */
export function notifyCategoriesChanged() {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(CHANGED))
}

/**
 * The account's conversation categories (archived included, for lookups).
 * `active` = pickable ones. Refetches when Settings changes them.
 */
export function useConversationCategories() {
  const { accountId } = useAuth()
  const [all, setAll] = useState<ConversationCategory[]>([])
  const [tick, setTick] = useState(0)

  useEffect(() => {
    const onChange = () => setTick((n) => n + 1)
    window.addEventListener(CHANGED, onChange)
    return () => window.removeEventListener(CHANGED, onChange)
  }, [])

  const refresh = useCallback(() => setTick((n) => n + 1), [])

  useEffect(() => {
    if (!accountId) return
    let cancelled = false
    listCategories(createClient(), accountId)
      .then((rows) => {
        if (!cancelled) setAll(rows)
      })
      .catch((err) => console.error('Failed to load categories:', err))
    return () => {
      cancelled = true
    }
  }, [accountId, tick])

  const active = useMemo(() => activeCategories(all), [all])
  const byId = useMemo(() => categoryMap(all), [all])
  return { all, active, byId, refresh }
}

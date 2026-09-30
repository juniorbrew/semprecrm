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

  // Other agents / tabs: realtime on the table, plus a refetch when the
  // window regains focus (realtime is best-effort).
  useEffect(() => {
    if (!accountId) return;
    const supabase = createClient();
    const channel = supabase
      // Unique topic per mount: several components use this hook at once and
      // `supabase.channel()` returns the already-subscribed one for a shared topic.
      .channel(`conversation-categories:${accountId}:${Math.random().toString(36).slice(2)}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "conversation_categories", filter: `account_id=eq.${accountId}` },
        () => setTick((n) => n + 1),
      )
      .subscribe();
    const onVisible = () => {
      if (document.visibilityState === "visible") setTick((n) => n + 1);
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      supabase.removeChannel(channel);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [accountId]);

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

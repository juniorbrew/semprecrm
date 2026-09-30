'use client'

import { useEffect, useState } from 'react'

import { useAuth } from '@/hooks/use-auth'
import { createClient } from '@/lib/supabase/client'
import { listSlaPolicies } from '@/lib/support/sla-policies'
import type { SlaPolicy } from '@/lib/support/sla'

const CHANGED = 'semprecrm:sla-policies-changed'

/** Call after saving the deadlines so open inboxes show / hide the SLA controls. */
export function notifySlaPoliciesChanged() {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(CHANGED))
}

/**
 * The account's SLA policies. `hasPolicies` gates every SLA control in the
 * inbox: an account without policies sees no change at all.
 */
export function useSlaPolicies() {
  const { accountId } = useAuth()
  const [policies, setPolicies] = useState<SlaPolicy[]>([])
  const [tick, setTick] = useState(0)

  useEffect(() => {
    const onChange = () => setTick((n) => n + 1)
    window.addEventListener(CHANGED, onChange)
    return () => window.removeEventListener(CHANGED, onChange)
  }, [])

  useEffect(() => {
    if (!accountId) return
    let cancelled = false
    listSlaPolicies(createClient(), accountId)
      .then((rows) => {
        if (!cancelled) setPolicies(rows)
      })
      .catch((err) => console.error('Failed to load SLA policies:', err))
    return () => {
      cancelled = true
    }
  }, [accountId, tick])

  return { policies, hasPolicies: policies.length > 0 }
}

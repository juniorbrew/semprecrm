"use client"

import Link from 'next/link'
import { useEffect, useState } from 'react'
import { CheckCircle2, Circle, X } from 'lucide-react'

import { useAuth } from '@/hooks/use-auth'
import { useLanguage } from '@/hooks/use-language'
import { createClient } from '@/lib/supabase/client'
import {
  loadOnboardingStatus,
  ONBOARDING_STEPS,
  onboardingComplete,
  trialDaysLeft,
  type OnboardingStatus,
} from '@/lib/dashboard/onboarding'

const dismissKey = (accountId: string) => `semprecrm:getting-started-dismissed:${accountId}`

function readDismissed(accountId: string | null): boolean {
  if (!accountId || typeof window === 'undefined') return false
  try {
    return window.localStorage.getItem(dismissKey(accountId)) === '1'
  } catch {
    return false
  }
}

/**
 * "Primeiros passos": the setup checklist on top of the dashboard. Shown to
 * owners/admins until the required steps are done or they hide it (per
 * account, in this browser). Each step ticks itself from the account data.
 */
export function GettingStarted() {
  const { t } = useLanguage()
  const { account, accountId, canManageMembers } = useAuth()
  const [status, setStatus] = useState<OnboardingStatus | null>(null)
  const [hidden, setHidden] = useState(false)

  useEffect(() => {
    if (!accountId || !canManageMembers) return
    let live = true
    loadOnboardingStatus(createClient(), accountId)
      .then((s) => {
        if (live) setStatus(s)
      })
      .catch((err) => console.error('[getting-started] status failed:', err))
    return () => {
      live = false
    }
  }, [accountId, canManageMembers])

  if (!canManageMembers || !status || hidden || readDismissed(accountId) || onboardingComplete(status)) return null

  const required = ONBOARDING_STEPS.filter((s) => !s.optional)
  const doneCount = required.filter((s) => status[s.id]).length
  const days = trialDaysLeft(account?.plan_status, account?.plan_expires_at)

  function hide() {
    setHidden(true)
    try {
      if (accountId) window.localStorage.setItem(dismissKey(accountId), '1')
    } catch {
      // Private mode / blocked storage: hidden for this visit only.
    }
  }

  return (
    <section aria-labelledby="getting-started-title" className="rounded-xl border border-border bg-card p-4 sm:p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 id="getting-started-title" className="text-base font-semibold text-foreground">
            {t('Getting started')}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {doneCount} {t('of')} {required.length} {t('steps done')}
            {days !== null ? (
              <>
                {' · '}
                {days === 1 ? t('1 day left in your free trial') : `${days} ${t('days left in your free trial')}`}
              </>
            ) : null}
          </p>
        </div>
        <button
          type="button"
          onClick={hide}
          aria-label={t('Hide getting started')}
          className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <X className="h-4 w-4" aria-hidden />
        </button>
      </div>
      <ol className="mt-4 divide-y divide-border">
        {ONBOARDING_STEPS.map((step) => {
          const done = status[step.id]
          return (
            <li key={step.id} className="flex items-center gap-3 py-3">
              {done ? (
                <CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-500" aria-hidden />
              ) : (
                <Circle className="h-5 w-5 shrink-0 text-muted-foreground" aria-hidden />
              )}
              <div className="min-w-0 flex-1">
                <p className={done ? 'text-sm font-medium text-muted-foreground line-through' : 'text-sm font-medium text-foreground'}>
                  {t(step.title)}
                  {step.optional ? <span className="ml-1.5 text-xs font-normal text-muted-foreground">({t('optional')})</span> : null}
                  <span className="sr-only">{done ? ` — ${t('done')}` : ''}</span>
                </p>
                {!done ? <p className="mt-0.5 text-xs text-muted-foreground">{t(step.description)}</p> : null}
              </div>
              {!done ? (
                <Link
                  href={step.href}
                  className="shrink-0 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-muted"
                >
                  {t(step.action)}
                </Link>
              ) : null}
            </li>
          )
        })}
      </ol>
    </section>
  )
}

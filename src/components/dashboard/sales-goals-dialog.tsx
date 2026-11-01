"use client"

import { useId, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { useLanguage } from '@/hooks/use-language'
import { goalKey, setGoal, type GoalProgress } from '@/lib/sales-goals/data'
import { parseTarget, type GoalMetric, type GoalScope } from '@/lib/sales-goals/pace'
import { createClient } from '@/lib/supabase/client'
import type { Team } from '@/lib/support/teams'

export interface Member {
  user_id: string
  name: string
}

const SELECT_CLASS =
  'h-9 w-full rounded-md border border-border bg-background px-2 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-60'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  accountId: string
  /** The current month, 'YYYY-MM-01': goals are always set from it on. */
  month: string
  /** Effective goals of the current month. */
  goals: GoalProgress[]
  teams: Team[]
  members: Member[]
  labelOf: (g: GoalProgress) => string
  format: (g: GoalProgress, n: number) => string
  onChanged: () => void
}

/**
 * "Definir metas": edit or remove the goals in force this month and add new
 * ones. Every change is valid from the current month on (the database
 * refuses past months); earlier months keep what they had.
 */
export function SalesGoalsDialog({ open, onOpenChange, accountId, month, goals, teams, members, labelOf, format, onChanged }: Props) {
  const { t } = useLanguage()
  const ids = { who: useId(), target: useId(), metric: useId(), value: useId(), hint: useId() }
  const invalidText = t('Enter a number above zero (whole number for deals won).')
  const [busy, setBusy] = useState(false)
  const [scope, setScope] = useState<GoalScope>('account')
  const [refId, setRefId] = useState('')
  const [metric, setMetric] = useState<GoalMetric>('won_value')
  const [value, setValue] = useState('')
  const [edits, setEdits] = useState<Record<string, string>>({})

  async function run(action: () => Promise<void>, done?: () => void) {
    setBusy(true)
    try {
      await action()
      done?.()
      onChanged()
    } catch (err) {
      console.error('[dashboard] sales goal save failed:', err)
      toast.error(t('Could not save the goal.'))
    } finally {
      setBusy(false)
    }
  }

  const newTarget = parseTarget(value, metric)
  const needsRef = scope !== 'account'
  const canAdd = newTarget !== null && (!needsRef || refId !== '') && !busy

  function add() {
    if (newTarget === null) return
    void run(
      () =>
        setGoal(createClient(), accountId, {
          scope,
          teamId: scope === 'team' ? refId : null,
          userId: scope === 'member' ? refId : null,
          metric,
          month,
          target: newTarget,
        }),
      () => setValue(''),
    )
  }

  const metricName = (m: GoalMetric) => (m === 'won_value' ? t('Won value') : t('Won deals'))

  return (
    <Dialog open={open} onOpenChange={(v) => (!busy ? onOpenChange(v) : undefined)}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t('Set goals')}</DialogTitle>
          <DialogDescription>
            {t('Goals are monthly and stay valid until you change them. Changes count from this month on; past months stay as they were.')}
          </DialogDescription>
        </DialogHeader>

        {goals.length > 0 && (
          <ul className="divide-y divide-border border-y border-border" aria-label={t('Goals in force')}>
            {goals.map((g) => {
              const key = goalKey(g)
              const text = edits[key] ?? String(g.target).replace('.', ',')
              const parsed = parseTarget(text, g.metric)
              const name = `${labelOf(g)} · ${metricName(g.metric)}`
              return (
                <li key={key} className="flex flex-wrap items-center gap-2 py-2.5">
                  <div className="min-w-0 flex-1 basis-40">
                    <p className="truncate text-sm font-medium text-foreground" data-no-translate>{labelOf(g)}</p>
                    <p className="text-xs text-muted-foreground">
                      {metricName(g.metric)} · {format(g, g.target)}
                    </p>
                  </div>
                  <Input
                    aria-label={`${t('Goal amount')}: ${name}`}
                    aria-describedby={parsed === null ? `${ids.hint}-${key}` : undefined}
                    inputMode="decimal"
                    value={text}
                    disabled={busy}
                    aria-invalid={parsed === null}
                    className="w-32"
                    onChange={(e) => setEdits((prev) => ({ ...prev, [key]: e.target.value }))}
                  />
                  {parsed === null && (
                    <p id={`${ids.hint}-${key}`} className="basis-full text-xs text-destructive">
                      {invalidText}
                    </p>
                  )}
                  <Button
                    size="sm"
                    variant="outline"
                    aria-label={`${t('Save')}: ${name}`}
                    disabled={busy || parsed === null || parsed === g.target}
                    onClick={() =>
                      void run(
                        () => setGoal(createClient(), accountId, { scope: g.scope, teamId: g.team_id, userId: g.user_id, metric: g.metric, month, target: parsed }),
                        () =>
                          setEdits((prev) => {
                            const next = { ...prev }
                            delete next[key]
                            return next
                          }),
                      )
                    }
                  >
                    {t('Save')}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`${t('Remove')}: ${name}`}
                    disabled={busy}
                    onClick={() =>
                      void run(() =>
                        setGoal(createClient(), accountId, { scope: g.scope, teamId: g.team_id, userId: g.user_id, metric: g.metric, month, target: null }),
                      )
                    }
                  >
                    {t('Remove')}
                  </Button>
                </li>
              )
            })}
          </ul>
        )}

        <form
          className="grid gap-3"
          onSubmit={(e) => {
            e.preventDefault()
            if (canAdd) add()
          }}
        >
          <p className="text-sm font-medium text-foreground">{t('New goal')}</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <label htmlFor={ids.who} className="text-xs font-medium text-muted-foreground">{t('Goal applies to')}</label>
              <select
                id={ids.who}
                className={SELECT_CLASS}
                value={scope}
                onChange={(e) => {
                  setScope(e.target.value as GoalScope)
                  setRefId('')
                }}
              >
                <option value="account">{t('Company')}</option>
                <option value="team">{t('Team')}</option>
                <option value="member">{t('A salesperson')}</option>
              </select>
            </div>
            {needsRef && (
              <div className="grid gap-1.5">
                <label htmlFor={ids.target} className="text-xs font-medium text-muted-foreground">
                  {t('Choose who the goal is for')}
                </label>
                <select id={ids.target} className={SELECT_CLASS} value={refId} onChange={(e) => setRefId(e.target.value)} data-no-translate>
                  <option value="">{t('Choose who the goal is for')}</option>
                  {scope === 'team'
                    ? teams.map((x) => (
                        <option key={x.id} value={x.id}>
                          {x.name}
                        </option>
                      ))
                    : members.map((m) => (
                        <option key={m.user_id} value={m.user_id}>
                          {m.name || t('Unnamed salesperson')}
                        </option>
                      ))}
                </select>
              </div>
            )}
            <div className="grid gap-1.5">
              <label htmlFor={ids.metric} className="text-xs font-medium text-muted-foreground">{t('What the goal measures')}</label>
              <select id={ids.metric} className={SELECT_CLASS} value={metric} onChange={(e) => setMetric(e.target.value as GoalMetric)}>
                <option value="won_value">{t('Won value')}</option>
                <option value="won_count">{t('Won deals')}</option>
              </select>
            </div>
            <div className="grid gap-1.5">
              <label htmlFor={ids.value} className="text-xs font-medium text-muted-foreground">{t('Goal amount')}</label>
              <Input
                id={ids.value}
                inputMode="decimal"
                value={value}
                disabled={busy}
                placeholder={metric === 'won_value' ? '50.000' : '20'}
                aria-invalid={value !== '' && newTarget === null}
                aria-describedby={value !== '' && newTarget === null ? ids.hint : undefined}
                onChange={(e) => setValue(e.target.value)}
              />
              {value !== '' && newTarget === null && (
                <p id={ids.hint} className="text-xs text-destructive">
                  {invalidText}
                </p>
              )}
            </div>
          </div>
          <div>
            <Button type="submit" disabled={!canAdd}>
              {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
              {t('Add goal')}
            </Button>
          </div>
        </form>

        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
            {t('Close')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

"use client"

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { ArrowRight, CheckSquare, Plus } from 'lucide-react'
import { toast } from 'sonner'

import { createClient } from '@/lib/supabase/client'
import { useAuth } from '@/hooks/use-auth'
import { useLanguage } from '@/hooks/use-language'
import {
  applyTaskFilters,
  completeTask,
  isOverdue,
  listTasks,
  openStatusIds,
  sortTasks,
  type Task,
} from '@/lib/tasks'
import {
  DueChip,
  PriorityChip,
  TaskDrawer,
  TaskLinkChip,
  useTaskStatuses,
  useTasksRealtime,
} from '@/components/tasks'
import { Checkbox } from '@/components/ui/checkbox'
import { EmptyState } from './empty-state'
import { Skeleton } from './skeleton'

/** Rows shown on the card; the rest lives behind "Ver todas". */
const MAX_ROWS = 6

interface TasksTodayProps {
  /** Bumped by the dashboard's refresh button. */
  refreshToken?: number
}

/**
 * "Tarefas de hoje" — the signed-in user's open tasks that are due
 * today or already overdue (sorted soonest first), with the complete
 * checkbox and a link to /tasks?filter=today. Kept live through the
 * tasks realtime channel.
 */
export function TasksToday({ refreshToken = 0 }: TasksTodayProps) {
  const { t } = useLanguage()
  const { user, accountId } = useAuth()
  const { statuses } = useTaskStatuses()
  const [tasks, setTasks] = useState<Task[] | null>(null)
  const [drawerTask, setDrawerTask] = useState<Task | null>(null)
  const [drawerOpen, setDrawerOpen] = useState(false)

  const userId = user?.id ?? null

  const load = useCallback(async () => {
    if (!userId || statuses.length === 0) return
    try {
      const rows = await listTasks(createClient(), {
        accountId,
        assigneeUserId: userId,
        statusIds: openStatusIds(statuses),
      })
      setTasks(sortTasks(applyTaskFilters(rows, { scope: 'today' }, { userId, statuses }), statuses))
    } catch (err) {
      console.error('[dashboard] tasks today failed:', err)
      setTasks([])
    }
  }, [userId, accountId, statuses])

  // `refreshToken` is only here to re-run the fetch on demand. The
  // setState calls all happen inside `load`'s awaited callbacks, never
  // synchronously in the effect body.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load()
  }, [load, refreshToken])

  useTasksRealtime(() => void load(), { tables: ['tasks'] })

  const complete = useCallback(
    async (task: Task) => {
      setTasks((prev) => (prev ? prev.filter((x) => x.id !== task.id) : prev))
      try {
        await completeTask(createClient(), task.id, statuses)
        toast.success(t('Task completed'))
      } catch (err) {
        console.error('[dashboard] complete task failed:', err)
        toast.error(t('Failed to save task'))
        void load()
      }
    },
    [statuses, t, load],
  )

  const visible = useMemo(() => (tasks ?? []).slice(0, MAX_ROWS), [tasks])
  const overdueCount = useMemo(
    () => (tasks ?? []).filter((x) => isOverdue(x.due_at)).length,
    [tasks],
  )
  const hidden = (tasks?.length ?? 0) - visible.length
  const loading = tasks === null

  return (
    <section className="flex h-full flex-col rounded-xl border border-border bg-card">
      <header className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
        <div>
          <h2 className="text-sm font-semibold text-foreground">{t("Today's tasks")}</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {loading
              ? t('Your tasks due today and overdue')
              : overdueCount > 0
                ? `${tasks!.length} ${t('to do')} · ${overdueCount} ${t(overdueCount === 1 ? 'overdue task' : 'overdue tasks')}`
                : `${tasks!.length} ${t('to do')}`}
          </p>
        </div>
        <Link
          href="/tasks?filter=today"
          className="inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-primary transition-colors hover:bg-primary/10"
        >
          {t('View all')}
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
            icon={CheckSquare}
            title={t('Nothing due today')}
            hint={t('Tasks assigned to you that are due today or overdue show up here.')}
          />
        ) : (
          <>
            <ul className="divide-y divide-border/60 overflow-hidden rounded-lg border border-border/60">
              {visible.map((task) => (
                <li
                  key={task.id}
                  className="flex items-start gap-3 px-3 py-2 transition-colors hover:bg-muted/50"
                >
                  <Checkbox
                    checked={false}
                    aria-label={t('Complete task')}
                    title={t('Complete task')}
                    onCheckedChange={(checked) => {
                      if (checked === true) void complete(task)
                    }}
                    className="mt-0.5"
                  />
                  <button
                    type="button"
                    onClick={() => {
                      setDrawerTask(task)
                      setDrawerOpen(true)
                    }}
                    className="min-w-0 flex-1 text-left"
                  >
                    <span className="flex items-center gap-2">
                      <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                        {task.title}
                      </span>
                      <PriorityChip priority={task.priority} compact />
                    </span>
                    <span className="mt-0.5 flex flex-wrap items-center gap-x-2">
                      <DueChip dueAt={task.due_at} className="-ml-1.5" />
                      <TaskLinkChip task={task} className="-ml-1.5" />
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            {hidden > 0 && (
              <p className="mt-2 text-[11px] text-muted-foreground">
                +{hidden} {t(hidden === 1 ? 'more task' : 'more tasks')}
              </p>
            )}
          </>
        )}
        <div className="mt-auto pt-3">
          <button
            type="button"
            onClick={() => {
              setDrawerTask(null)
              setDrawerOpen(true)
            }}
            className="inline-flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            <Plus className="h-3.5 w-3.5" aria-hidden />
            {t('New task')}
          </button>
        </div>
      </div>

      <TaskDrawer
        open={drawerOpen}
        onOpenChange={setDrawerOpen}
        task={drawerTask}
        defaults={{ assignee_user_id: userId ?? undefined }}
        statuses={statuses}
        onCreated={() => void load()}
        onUpdated={() => void load()}
        onDeleted={(id) => setTasks((prev) => (prev ? prev.filter((x) => x.id !== id) : prev))}
      />
    </section>
  )
}

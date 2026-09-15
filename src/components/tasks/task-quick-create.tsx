"use client";

import { useMemo, useState } from "react";
import { CalendarClock, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { createClient } from "@/lib/supabase/client";
import { notifyPushEvent } from "@/lib/push/client";
import { useAuth } from "@/hooks/use-auth";
import { useLanguage } from "@/hooks/use-language";
import {
  createTask,
  fromDateTimeLocal,
  toDateTimeLocal,
  type Task,
  type TaskInput,
  type TaskStatus,
} from "@/lib/tasks";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import { useTaskStatuses } from "./hooks";

export interface TaskQuickCreateProps {
  /**
   * Links and other prefills for the new task — the inbox panel passes
   * `{ contact_id, conversation_id }`, the deal drawer `{ deal_id,
   * contact_id }`. `title` / `due_at` seed the two inputs.
   */
  defaults?: Partial<TaskInput>;
  /** Pass when the parent already holds the statuses. */
  statuses?: TaskStatus[];
  /** Resolves with the created row; the parent appends it to its list. */
  onCreated?: (task: Task) => void;
  /** Esc / "Cancelar". */
  onCancel?: () => void;
  /** Placeholder for the title box. */
  placeholder?: string;
  /** Keep the form open and clear it after a save (default: closes via onCancel). */
  stayOpen?: boolean;
  className?: string;
}

/**
 * Compact inline "title + due" creator revealed by a panel's "+".
 * Enter or the button saves; Esc / Cancelar collapses. Everything else
 * (priority, assignee, description) is left for the full drawer.
 */
export function TaskQuickCreate({
  defaults,
  statuses: statusesProp,
  onCreated,
  onCancel,
  placeholder,
  stayOpen,
  className,
}: TaskQuickCreateProps) {
  const { t } = useLanguage();
  const { accountId, user } = useAuth();
  const supabase = useMemo(() => createClient(), []);
  const own = useTaskStatuses({ enabled: !statusesProp });
  const statuses = statusesProp ?? own.statuses;

  const [title, setTitle] = useState(defaults?.title ?? "");
  const [due, setDue] = useState(() => toDateTimeLocal(defaults?.due_at ?? null));
  const [saving, setSaving] = useState(false);

  const canSave = title.trim().length > 0 && !saving && statuses.length > 0;

  async function save() {
    if (!canSave) return;
    if (!accountId) {
      toast.error(t("Your profile is not linked to an account."));
      return;
    }
    setSaving(true);
    try {
      const created = await createTask(
        supabase,
        { accountId, userId: user?.id ?? null, statuses },
        {
          ...defaults,
          title: title.trim(),
          due_at: fromDateTimeLocal(due),
        },
      );
      toast.success(t("Task created"));
      if (created.assignee_user_id) {
        notifyPushEvent({ kind: "task_assigned", task_id: created.id });
      }
      onCreated?.(created);
      setTitle("");
      setDue("");
      if (!stayOpen) onCancel?.();
    } catch (err) {
      toast.error(t("Failed to create task"));
      console.error(err);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className={
        className ??
        "rounded-lg border border-dashed border-primary/40 bg-primary/5 p-2"
      }
    >
      <Input
        value={title}
        autoFocus
        disabled={saving}
        placeholder={placeholder ?? t("What needs to be done?")}
        aria-label={t("Task title")}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void save();
          } else if (e.key === "Escape") {
            e.preventDefault();
            onCancel?.();
          }
        }}
        className="h-8 border-transparent bg-background/60 text-xs text-foreground md:text-xs"
      />
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
        <label className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <CalendarClock className="h-3.5 w-3.5" />
          <input
            type="datetime-local"
            value={due}
            disabled={saving}
            aria-label={t("Due")}
            onChange={(e) => setDue(e.target.value)}
            className="h-7 rounded-md border border-transparent bg-background/60 px-1.5 text-[11px] text-foreground outline-none focus:border-primary"
          />
        </label>
        <div className="flex items-center gap-1">
          {onCancel && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onCancel}
              disabled={saving}
              className="h-7 px-2 text-xs text-muted-foreground hover:bg-muted"
            >
              {t("Cancel")}
            </Button>
          )}
          <Button
            type="button"
            size="sm"
            onClick={() => void save()}
            disabled={!canSave}
            className="h-7 bg-primary px-2.5 text-xs text-primary-foreground hover:bg-primary/90"
          >
            {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : t("Add task")}
          </Button>
        </div>
      </div>
    </div>
  );
}

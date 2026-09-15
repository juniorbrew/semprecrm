"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Check,
  GitBranch,
  Loader2,
  MessageSquare,
  RotateCcw,
  Search,
  Send,
  Trash2,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { createClient } from "@/lib/supabase/client";
import { notifyPushEvent } from "@/lib/push/client";
import { useAuth } from "@/hooks/use-auth";
import { useLanguage } from "@/hooks/use-language";
import { inboxConversationHref } from "@/lib/conversations/find-by-contact";
import { relativeTime, longDateTime } from "@/lib/pipelines/deal-dates";
import {
  addTaskComment,
  attachAuthors,
  completeTask,
  createTask,
  deleteTask,
  fromDateTimeLocal,
  isTaskDone,
  listTaskComments,
  reopenTask,
  sortStatuses,
  toDateTimeLocal,
  updateTask,
  TASK_PRIORITIES,
  type Task,
  type TaskComment,
  type TaskContactRef,
  type TaskDealRef,
  type TaskInput,
  type TaskMember,
  type TaskPatch,
  type TaskPriority,
  type TaskStatus,
} from "@/lib/tasks";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

import { useTaskMembers, useTaskStatuses } from "./hooks";
import { AssigneeAvatar, PRIORITY_LABELS, StatusChip, memberLabel } from "./task-chips";

const SELECT_CLASS =
  "h-8 w-full rounded-lg border border-border bg-muted px-2.5 text-sm text-foreground outline-none focus:border-primary focus:ring-1 focus:ring-primary disabled:cursor-not-allowed disabled:opacity-60";

export interface TaskDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Existing task → edit (inline autosave); `null` → create form. */
  task: Task | null;
  /**
   * Prefill for create mode — e.g. `{ contact_id, conversation_id,
   * title: "Atendimento: Maria" }` from the inbox, or `{ deal_id,
   * contact_id }` from a deal. Ignored in edit mode.
   */
  defaults?: Partial<TaskInput>;
  /** Pass when the parent already holds them; otherwise the drawer loads them. */
  statuses?: TaskStatus[];
  members?: TaskMember[];
  onCreated?: (task: Task) => void;
  onUpdated?: (task: Task) => void;
  onDeleted?: (taskId: string) => void;
}

/**
 * Right-hand sheet for one task. Create and edit share the same
 * fields; in edit mode every change is saved as it happens (blur for
 * text, change for selects), and the footer carries Concluir /
 * Reabrir plus a guarded Excluir. Comments live at the bottom.
 */
export function TaskDrawer({
  open,
  onOpenChange,
  task,
  defaults,
  statuses: statusesProp,
  members: membersProp,
  onCreated,
  onUpdated,
  onDeleted,
}: TaskDrawerProps) {
  const own = useTaskStatuses({ enabled: !statusesProp && open });
  const ownMembers = useTaskMembers({ enabled: !membersProp && open });
  const statuses = statusesProp ?? own.statuses;
  const members = membersProp ?? ownMembers.members;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full border-border bg-popover p-0 text-popover-foreground data-[side=right]:sm:max-w-[520px]"
        aria-describedby={undefined}
      >
        <TaskDrawerBody
          // Reset the form when a different task (or "new") opens.
          key={task?.id ?? "new"}
          task={task}
          defaults={defaults}
          statuses={statuses}
          members={members}
          onClose={() => onOpenChange(false)}
          onCreated={onCreated}
          onUpdated={onUpdated}
          onDeleted={onDeleted}
        />
      </SheetContent>
    </Sheet>
  );
}

// ------------------------------------------------------------
// Body
// ------------------------------------------------------------

interface BodyProps {
  task: Task | null;
  defaults?: Partial<TaskInput>;
  statuses: TaskStatus[];
  members: TaskMember[];
  onClose: () => void;
  onCreated?: (task: Task) => void;
  onUpdated?: (task: Task) => void;
  onDeleted?: (taskId: string) => void;
}

function TaskDrawerBody({
  task,
  defaults,
  statuses,
  members,
  onClose,
  onCreated,
  onUpdated,
  onDeleted,
}: BodyProps) {
  const supabase = useMemo(() => createClient(), []);
  const { t, language } = useLanguage();
  const { accountId, user, canSendMessages } = useAuth();
  const isEdit = !!task;
  const readOnly = !canSendMessages;
  const sorted = useMemo(() => sortStatuses(statuses), [statuses]);

  // ---- form state -------------------------------------------------
  const [title, setTitle] = useState(task?.title ?? defaults?.title ?? "");
  const [description, setDescription] = useState(
    task?.description ?? defaults?.description ?? "",
  );
  const [priority, setPriority] = useState<TaskPriority>(
    task?.priority ?? defaults?.priority ?? "normal",
  );
  const [statusId, setStatusId] = useState(task?.status_id ?? defaults?.status_id ?? "");
  const [assignee, setAssignee] = useState(
    task?.assignee_user_id ?? defaults?.assignee_user_id ?? "",
  );
  const [dueLocal, setDueLocal] = useState(
    toDateTimeLocal(task?.due_at ?? defaults?.due_at ?? null),
  );
  const [contact, setContact] = useState<TaskContactRef | null>(task?.contact ?? null);
  const [contactId, setContactId] = useState(
    task?.contact_id ?? defaults?.contact_id ?? "",
  );
  const [dealId, setDealId] = useState(task?.deal_id ?? defaults?.deal_id ?? "");
  const [conversationId, setConversationId] = useState(
    task?.conversation_id ?? defaults?.conversation_id ?? "",
  );

  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState<"complete" | "reopen" | "delete" | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Default status for a new task once the list is known.
  useEffect(() => {
    if (isEdit || statusId || sorted.length === 0) return;
    const def = sorted.find((s) => s.is_default) ?? sorted.find((s) => s.kind === "open") ?? sorted[0];
    setStatusId(def.id);
  }, [isEdit, statusId, sorted]);

  // Resolve a prefilled contact id (create mode) to its name/phone.
  useEffect(() => {
    if (contact || !contactId) return;
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from("contacts")
        .select("id, name, phone, avatar_url")
        .eq("id", contactId)
        .maybeSingle();
      if (!cancelled && data) setContact(data as TaskContactRef);
    })();
    return () => {
      cancelled = true;
    };
  }, [contact, contactId, supabase]);

  // Deals of the linked contact (for the deal select).
  const [deals, setDeals] = useState<TaskDealRef[]>([]);
  useEffect(() => {
    if (!contactId) {
        setDeals([]);
      return;
    }
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from("deals")
        .select("id, title, pipeline_id")
        .eq("contact_id", contactId)
        .order("created_at", { ascending: false });
      if (!cancelled) setDeals((data ?? []) as TaskDealRef[]);
    })();
    return () => {
      cancelled = true;
    };
  }, [contactId, supabase]);

  // ---- persistence ------------------------------------------------
  const persist = useCallback(
    async (patch: TaskPatch) => {
      if (!task) return;
      setSaving(true);
      try {
        const updated = await updateTask(supabase, task.id, patch);
        onUpdated?.(updated);
        // Push (spec round 2 §5b): the server notifies the new assignee
        // unless it is the caller.
        if (patch.assignee_user_id && patch.assignee_user_id !== task.assignee_user_id) {
          notifyPushEvent({ kind: "task_assigned", task_id: task.id });
        }
      } catch (err) {
        toast.error(t("Failed to save task"));
        console.error(err);
      } finally {
        setSaving(false);
      }
    },
    [task, supabase, onUpdated, t],
  );

  async function handleCreate() {
    const trimmed = title.trim();
    if (!trimmed) {
      toast.error(t("Task title is required"));
      return;
    }
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
          title: trimmed,
          description,
          priority,
          status_id: statusId || null,
          assignee_user_id: assignee || null,
          contact_id: contactId || null,
          conversation_id: conversationId || null,
          deal_id: dealId || null,
          due_at: fromDateTimeLocal(dueLocal),
        },
      );
      toast.success(t("Task created"));
      if (created.assignee_user_id) {
        notifyPushEvent({ kind: "task_assigned", task_id: created.id });
      }
      onCreated?.(created);
      onClose();
    } catch (err) {
      toast.error(t("Failed to create task"));
      console.error(err);
    } finally {
      setSaving(false);
    }
  }

  async function handleComplete() {
    if (!task) return;
    setBusy("complete");
    try {
      const updated = await completeTask(supabase, task.id, statuses);
      setStatusId(updated.status_id);
      onUpdated?.(updated);
      toast.success(t("Task completed"));
    } catch (err) {
      toast.error(t("Failed to save task"));
      console.error(err);
    } finally {
      setBusy(null);
    }
  }

  async function handleReopen() {
    if (!task) return;
    setBusy("reopen");
    try {
      const updated = await reopenTask(supabase, task.id, statuses);
      setStatusId(updated.status_id);
      onUpdated?.(updated);
      toast.success(t("Task reopened"));
    } catch (err) {
      toast.error(t("Failed to save task"));
      console.error(err);
    } finally {
      setBusy(null);
    }
  }

  async function handleDelete() {
    if (!task) return;
    setBusy("delete");
    try {
      await deleteTask(supabase, task.id);
      toast.success(t("Task deleted"));
      onDeleted?.(task.id);
      onClose();
    } catch (err) {
      toast.error(t("Failed to delete task"));
      console.error(err);
    } finally {
      setBusy(null);
    }
  }

  const currentStatus = sorted.find((s) => s.id === statusId) ?? null;
  const done = isEdit && isTaskDone({ status_id: statusId }, statuses);
  const assigneeMember = members.find((m) => m.user_id === assignee) ?? null;

  return (
    <div className="flex h-full flex-col">
      <SheetHeader className="gap-1 border-b border-border/50 p-4 pr-12">
        <div className="flex items-center gap-2">
          <SheetTitle className="text-popover-foreground">
            {isEdit ? t("Task") : t("New task")}
          </SheetTitle>
          {isEdit && <StatusChip status={currentStatus} />}
          {saving && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
        </div>
        {isEdit && task && (
          <p className="text-xs text-muted-foreground">
            {t("Created")} {relativeTime(task.created_at, language)}
            {task.completed_at && (
              <>
                {" · "}
                {t("Completed")} {relativeTime(task.completed_at, language)}
              </>
            )}
          </p>
        )}
      </SheetHeader>

      <div className="flex-1 space-y-4 overflow-y-auto p-4">
        {/* Title */}
        <div className="grid gap-1.5">
          <Label className="text-muted-foreground">{t("Title")}</Label>
          <Input
            value={title}
            disabled={readOnly}
            autoFocus={!isEdit}
            placeholder={t("What needs to be done?")}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={() => {
              if (!isEdit) return;
              const trimmed = title.trim();
              if (!trimmed) {
                setTitle(task!.title);
                return;
              }
              if (trimmed !== task!.title) void persist({ title: trimmed });
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                if (isEdit) (e.target as HTMLInputElement).blur();
                else void handleCreate();
              }
            }}
            className="border-border bg-muted text-base font-medium text-foreground md:text-sm"
          />
        </div>

        {/* Description */}
        <div className="grid gap-1.5">
          <Label className="text-muted-foreground">{t("Description")}</Label>
          <Textarea
            value={description}
            disabled={readOnly}
            rows={3}
            placeholder={t("Details, context, next steps…")}
            onChange={(e) => setDescription(e.target.value)}
            onBlur={() => {
              if (!isEdit) return;
              if ((description.trim() || null) !== (task!.description ?? null)) {
                void persist({ description });
              }
            }}
            className="min-h-20 border-border bg-muted text-foreground"
          />
        </div>

        {/* Status + priority */}
        <div className="grid grid-cols-2 gap-3">
          <div className="grid gap-1.5">
            <Label className="text-muted-foreground">{t("Status")}</Label>
            <select
              value={statusId}
              disabled={readOnly || sorted.length === 0}
              onChange={(e) => {
                setStatusId(e.target.value);
                if (isEdit) void persist({ status_id: e.target.value });
              }}
              className={SELECT_CLASS}
            >
              {sorted.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
          <div className="grid gap-1.5">
            <Label className="text-muted-foreground">{t("Priority")}</Label>
            <select
              value={priority}
              disabled={readOnly}
              onChange={(e) => {
                const next = e.target.value as TaskPriority;
                setPriority(next);
                if (isEdit) void persist({ priority: next });
              }}
              className={SELECT_CLASS}
            >
              {TASK_PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {t(PRIORITY_LABELS[p])}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Assignee + due */}
        <div className="grid grid-cols-2 gap-3">
          <div className="grid gap-1.5">
            <Label className="text-muted-foreground">{t("Assignee")}</Label>
            <select
              value={assignee}
              disabled={readOnly}
              onChange={(e) => {
                setAssignee(e.target.value);
                if (isEdit) void persist({ assignee_user_id: e.target.value || null });
              }}
              className={SELECT_CLASS}
            >
              <option value="">{t("Unassigned")}</option>
              {members.map((m) => (
                <option key={m.user_id} value={m.user_id}>
                  {memberLabel(m)}
                </option>
              ))}
            </select>
            {assigneeMember && (
              <AssigneeAvatar member={assigneeMember} showName className="px-0.5" />
            )}
          </div>
          <div className="grid gap-1.5">
            <Label className="text-muted-foreground">{t("Due")}</Label>
            <Input
              type="datetime-local"
              value={dueLocal}
              disabled={readOnly}
              onChange={(e) => {
                setDueLocal(e.target.value);
                if (isEdit) void persist({ due_at: fromDateTimeLocal(e.target.value) });
              }}
              className="border-border bg-muted text-foreground"
            />
          </div>
        </div>

        {/* Links */}
        <div className="grid gap-3 rounded-lg border border-border/60 p-3">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            {t("Links")}
          </p>
          <div className="grid gap-1.5">
            <Label className="text-muted-foreground">{t("Contact")}</Label>
            <ContactPicker
              contact={contact}
              disabled={readOnly}
              onChange={(next) => {
                setContact(next);
                const nextId = next?.id ?? "";
                setContactId(nextId);
                // A deal belongs to a contact — drop it when the contact changes.
                if (dealId) setDealId("");
                if (isEdit) {
                  void persist({
                    contact_id: nextId || null,
                    ...(dealId ? { deal_id: null } : {}),
                  });
                }
              }}
            />
          </div>
          {contactId && (
            <div className="grid gap-1.5">
              <Label className="text-muted-foreground">{t("Deal")}</Label>
              <div className="flex items-center gap-2">
                <select
                  value={dealId}
                  disabled={readOnly || deals.length === 0}
                  onChange={(e) => {
                    setDealId(e.target.value);
                    if (isEdit) void persist({ deal_id: e.target.value || null });
                  }}
                  className={SELECT_CLASS}
                >
                  <option value="">
                    {deals.length === 0 ? t("No deals for this contact") : t("No deal")}
                  </option>
                  {deals.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.title}
                    </option>
                  ))}
                </select>
                {dealId && (
                  <Link
                    href="/pipelines"
                    title={t("Open in Pipelines")}
                    className="inline-flex h-8 shrink-0 items-center gap-1 rounded-lg border border-border px-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
                  >
                    <GitBranch className="h-3.5 w-3.5" />
                  </Link>
                )}
              </div>
            </div>
          )}
          {conversationId && (
            <div className="flex items-center justify-between gap-2 text-xs">
              <Link
                href={inboxConversationHref(conversationId)}
                className="inline-flex items-center gap-1.5 text-primary hover:underline"
              >
                <MessageSquare className="h-3.5 w-3.5" />
                {t("Open conversation")}
              </Link>
              {!readOnly && (
                <button
                  type="button"
                  onClick={() => {
                    setConversationId("");
                    if (isEdit) void persist({ conversation_id: null });
                  }}
                  className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
                >
                  <X className="h-3 w-3" />
                  {t("Unlink")}
                </button>
              )}
            </div>
          )}
        </div>

        {/* Comments */}
        {isEdit && task && (
          <TaskComments
            taskId={task.id}
            accountId={task.account_id}
            members={members}
            readOnly={readOnly}
          />
        )}
      </div>

      {/* Footer */}
      <div className="border-t border-border/50 bg-popover/50 p-3">
        {isEdit ? (
          confirmDelete ? (
            <div className="flex items-center gap-3 rounded-lg border border-red-500/30 bg-red-500/10 p-3">
              <AlertTriangle className="h-4 w-4 shrink-0 text-red-400" />
              <p className="flex-1 text-xs text-foreground">{t("Delete this task? This cannot be undone.")}</p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setConfirmDelete(false)}
                className="border-border text-muted-foreground hover:bg-muted"
              >
                {t("Cancel")}
              </Button>
              <Button
                type="button"
                size="sm"
                onClick={handleDelete}
                disabled={busy === "delete"}
                className="bg-red-600 text-white hover:bg-red-700"
              >
                {busy === "delete" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : t("Delete")}
              </Button>
            </div>
          ) : (
            <div className="flex items-center justify-between gap-2">
              {!readOnly ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setConfirmDelete(true)}
                  className="text-muted-foreground hover:bg-red-500/10 hover:text-red-500"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  {t("Delete")}
                </Button>
              ) : (
                <span />
              )}
              {!readOnly &&
                (done ? (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={handleReopen}
                    disabled={busy !== null}
                    className="border-border text-foreground hover:bg-muted"
                  >
                    {busy === "reopen" ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <RotateCcw className="h-4 w-4" />
                    )}
                    {t("Reopen")}
                  </Button>
                ) : (
                  <Button
                    type="button"
                    onClick={handleComplete}
                    disabled={busy !== null}
                    className="bg-primary text-primary-foreground hover:bg-primary/90"
                  >
                    {busy === "complete" ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Check className="h-4 w-4" />
                    )}
                    {t("Complete")}
                  </Button>
                ))}
            </div>
          )
        ) : (
          <div className="flex items-center justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={onClose}
              className="border-border text-muted-foreground hover:bg-muted"
            >
              {t("Cancel")}
            </Button>
            <Button
              type="button"
              onClick={handleCreate}
              disabled={saving || !title.trim() || readOnly}
              className="bg-primary text-primary-foreground hover:bg-primary/90"
            >
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {t("Create task")}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------
// Contact picker — search by name / phone, show the pick as a chip.
// ------------------------------------------------------------

function ContactPicker({
  contact,
  disabled,
  onChange,
}: {
  contact: TaskContactRef | null;
  disabled?: boolean;
  onChange: (contact: TaskContactRef | null) => void;
}) {
  const { t } = useLanguage();
  const supabase = useMemo(() => createClient(), []);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<TaskContactRef[]>([]);
  const [openList, setOpenList] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    const q = query.trim();
    // Clearing happens inside the same debounced tick so the effect body
    // never sets state synchronously.
    timer.current = setTimeout(async () => {
      if (!q) {
        setResults([]);
        return;
      }
      const like = `%${q.replace(/[%_,]/g, " ")}%`;
      const { data } = await supabase
        .from("contacts")
        .select("id, name, phone, avatar_url")
        .or(`name.ilike.${like},phone.ilike.${like}`)
        .order("name")
        .limit(8);
      setResults((data ?? []) as TaskContactRef[]);
    }, 200);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [query, supabase]);

  if (contact) {
    return (
      <div className="flex h-8 items-center gap-2 rounded-lg border border-border bg-muted px-2.5 text-sm text-foreground">
        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/15 text-[10px] font-semibold text-primary">
          {(contact.name || contact.phone).charAt(0).toUpperCase()}
        </span>
        <span className="min-w-0 flex-1 truncate">{contact.name || contact.phone}</span>
        {contact.name && (
          <span className="hidden text-xs text-muted-foreground sm:inline">{contact.phone}</span>
        )}
        {!disabled && (
          <button
            type="button"
            onClick={() => onChange(null)}
            aria-label={t("Unlink")}
            title={t("Unlink")}
            className="text-muted-foreground hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="relative">
      <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
      <Input
        value={query}
        disabled={disabled}
        placeholder={t("Search contact by name or phone")}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpenList(true);
        }}
        onFocus={() => setOpenList(true)}
        onBlur={() => setTimeout(() => setOpenList(false), 120)}
        className="border-border bg-muted pl-8 text-foreground"
      />
      {openList && results.length > 0 && (
        <ul className="absolute z-20 mt-1 max-h-56 w-full overflow-y-auto rounded-lg border border-border bg-popover p-1 shadow-lg">
          {results.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  onChange(c);
                  setQuery("");
                  setResults([]);
                  setOpenList(false);
                }}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-popover-foreground hover:bg-muted"
              >
                <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-semibold text-foreground">
                  {(c.name || c.phone).charAt(0).toUpperCase()}
                </span>
                <span className="min-w-0 flex-1 truncate">{c.name || c.phone}</span>
                {c.name && <span className="text-xs text-muted-foreground">{c.phone}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ------------------------------------------------------------
// Comments
// ------------------------------------------------------------

function TaskComments({
  taskId,
  accountId,
  members,
  readOnly,
}: {
  taskId: string;
  accountId: string;
  members: TaskMember[];
  readOnly: boolean;
}) {
  const supabase = useMemo(() => createClient(), []);
  const { t, language } = useLanguage();
  const { user } = useAuth();
  const [comments, setComments] = useState<TaskComment[] | null>(null);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);

  const load = useCallback(async () => {
    try {
      const rows = await listTaskComments(supabase, taskId);
      setComments(rows);
    } catch (err) {
      console.error(err);
      setComments([]);
    }
  }, [supabase, taskId]);

  useEffect(() => {
    void load();
  }, [load]);

  const withAuthors = useMemo(
    () => attachAuthors(comments ?? [], members),
    [comments, members],
  );

  async function send() {
    const body = text.trim();
    if (!body || sending) return;
    setSending(true);
    try {
      const created = await addTaskComment(supabase, {
        accountId,
        taskId,
        userId: user?.id ?? null,
        body,
      });
      setComments((prev) => [...(prev ?? []), created]);
      setText("");
    } catch (err) {
      toast.error(t("Failed to add comment"));
      console.error(err);
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="grid gap-2">
      <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        {t("Comments")}
        {comments && comments.length > 0 && (
          <span className="ml-1.5 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium normal-case tracking-normal">
            {comments.length}
          </span>
        )}
      </p>
      {comments === null ? (
        <div className="h-10 animate-pulse rounded-lg bg-muted/50" />
      ) : withAuthors.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t("No comments yet.")}</p>
      ) : (
        <ul className="space-y-2">
          {withAuthors.map((c) => (
            <li key={c.id} className="rounded-lg border border-border/60 bg-muted/40 p-2.5">
              <div className="flex items-center justify-between gap-2">
                <AssigneeAvatar member={c.author} showName />
                <span
                  title={longDateTime(c.created_at, language)}
                  className="shrink-0 text-[11px] text-muted-foreground"
                >
                  {relativeTime(c.created_at, language)}
                </span>
              </div>
              <p className="mt-1.5 whitespace-pre-wrap break-words text-sm text-foreground">{c.body}</p>
            </li>
          ))}
        </ul>
      )}
      {!readOnly && (
        <div className="flex items-end gap-2">
          <Textarea
            value={text}
            rows={2}
            disabled={sending}
            placeholder={t("Write a comment…")}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                void send();
              }
            }}
            className={cn("min-h-10 flex-1 border-border bg-muted text-foreground")}
          />
          <Button
            type="button"
            size="icon"
            onClick={() => void send()}
            disabled={!text.trim() || sending}
            title={t("Ctrl+Enter to send")}
            aria-label={t("Send comment")}
            className="bg-primary text-primary-foreground hover:bg-primary/90"
          >
            {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          </Button>
        </div>
      )}
    </div>
  );
}

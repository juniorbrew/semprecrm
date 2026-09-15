"use client";

import { useEffect, useMemo, useState } from "react";
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { AlertTriangle, CheckSquare, GripVertical, Loader2, Plus, Star, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { useLanguage } from "@/hooks/use-language";
import {
  TASK_STATUS_COLORS,
  TASK_STATUS_KINDS,
  TASK_STATUS_KIND_LABELS,
  canDeleteStatus,
  createTaskStatus,
  defaultStatusForKind,
  deleteTaskStatus,
  listTaskStatuses,
  reorderTaskStatuses,
  setDefaultTaskStatus,
  sortStatuses,
  updateTaskStatus,
  validateStatusSet,
  type TaskStatus,
  type TaskStatusKind,
} from "@/lib/tasks";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

import { SettingsPanelHead } from "./settings-panel-head";

const SELECT_CLASS =
  "h-8 rounded-lg border border-border bg-card px-2 text-xs text-foreground outline-none focus:border-primary focus:ring-1 focus:ring-primary disabled:cursor-not-allowed disabled:opacity-60";

/**
 * Configurações → Tarefas: the account's task statuses (board columns).
 * Drag to reorder, rename inline (saved on blur), pick colour and kind,
 * flag the default, add and delete (tasks move to the default of the
 * same kind). Admin+ only — RLS enforces it, the UI mirrors it.
 */
export function TaskStatusesSettings() {
  const supabase = useMemo(() => createClient(), []);
  const { t } = useLanguage();
  const { accountId, canEditSettings, profileLoading } = useAuth();
  const readOnly = !canEditSettings;

  const [statuses, setStatuses] = useState<TaskStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const [newName, setNewName] = useState("");
  const [newKind, setNewKind] = useState<TaskStatusKind>("open");
  const [newColor, setNewColor] = useState<string>(TASK_STATUS_COLORS[0]);
  const [adding, setAdding] = useState(false);

  async function reload() {
    if (!accountId) return;
    try {
      setStatuses(await listTaskStatuses(supabase, accountId));
    } catch (err) {
      console.error(err);
      toast.error(t("Failed to load task statuses"));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;
    (async () => {
      try {
        const rows = await listTaskStatuses(supabase, accountId);
        if (!cancelled) setStatuses(rows);
      } catch (err) {
        console.error(err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [accountId, supabase]);

  const problems = useMemo(() => validateStatusSet(statuses), [statuses]);
  const missingKinds = problems
    .filter((p): p is { code: "missing_kind"; kind: TaskStatusKind } => p.code === "missing_kind")
    .map((p) => p.kind);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  async function handleReorder({ active, over }: DragEndEvent) {
    if (!over || active.id === over.id) return;
    const from = statuses.findIndex((s) => s.id === active.id);
    const to = statuses.findIndex((s) => s.id === over.id);
    if (from < 0 || to < 0) return;
    const next = arrayMove(statuses, from, to).map((s, i) => ({ ...s, position: i }));
    setStatuses(next);
    try {
      await reorderTaskStatuses(supabase, next);
    } catch (err) {
      console.error(err);
      toast.error(t("Failed to save"));
      await reload();
    }
  }

  async function patch(id: string, changes: Partial<Pick<TaskStatus, "name" | "color" | "kind">>) {
    const current = statuses.find((s) => s.id === id);
    if (!current) return;
    // Refuse to change the kind when that would leave the kind empty.
    if (changes.kind && changes.kind !== current.kind) {
      const remaining = statuses.filter((s) => s.id !== id && s.kind === current.kind);
      if (remaining.length === 0) {
        toast.error(t("Keep at least one status of each kind."));
        return;
      }
    }
    setStatuses((prev) => prev.map((s) => (s.id === id ? { ...s, ...changes } : s)));
    setBusyId(id);
    try {
      await updateTaskStatus(supabase, id, changes);
    } catch (err) {
      console.error(err);
      toast.error(t("Failed to save"));
      await reload();
    } finally {
      setBusyId(null);
    }
  }

  async function makeDefault(id: string) {
    if (!accountId) return;
    setStatuses((prev) => prev.map((s) => ({ ...s, is_default: s.id === id })));
    setBusyId(id);
    try {
      await setDefaultTaskStatus(supabase, accountId, id);
    } catch (err) {
      console.error(err);
      toast.error(t("Failed to save"));
      await reload();
    } finally {
      setBusyId(null);
    }
  }

  async function handleAdd() {
    if (!accountId) return;
    const name = newName.trim();
    if (!name) return;
    setAdding(true);
    try {
      await createTaskStatus(supabase, accountId, statuses, { name, kind: newKind, color: newColor });
      setNewName("");
      setNewColor(TASK_STATUS_COLORS[(statuses.length + 1) % TASK_STATUS_COLORS.length]);
      await reload();
      toast.success(t("Status created"));
    } catch (err) {
      console.error(err);
      toast.error(t("Failed to create status"));
    } finally {
      setAdding(false);
    }
  }

  async function handleDelete(id: string) {
    setBusyId(id);
    try {
      await deleteTaskStatus(supabase, statuses, id);
      setConfirmDeleteId(null);
      await reload();
      toast.success(t("Status deleted"));
    } catch (err) {
      console.error(err);
      toast.error(t("Failed to delete status"));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="max-w-2xl animate-in fade-in-50 duration-200">
      <SettingsPanelHead
        title={t("Tasks")}
        description={t(
          "The columns of the task board. Every account keeps at least one open, one in-progress and one done status; new tasks land on the default.",
        )}
      />
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-foreground">
            <CheckSquare className="size-4 text-primary" />
            {t("Task statuses")}
          </CardTitle>
          <CardDescription className="text-muted-foreground">
            {t("Drag to reorder. Names are saved when you leave the field.")}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {loading || profileLoading ? (
            <div className="space-y-2">
              {[1, 2, 3].map((i) => (
                <div key={i} className="h-12 animate-pulse rounded-lg bg-muted/60" />
              ))}
            </div>
          ) : (
            <>
              {missingKinds.length > 0 && (
                <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-foreground">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
                  <span>
                    {t("Missing a status of kind:")}{" "}
                    {missingKinds.map((k) => t(TASK_STATUS_KIND_LABELS[k])).join(", ")}
                  </span>
                </div>
              )}

              <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleReorder}>
                <SortableContext
                  items={statuses.map((s) => s.id)}
                  strategy={verticalListSortingStrategy}
                >
                  <div className="space-y-2">
                    {sortStatuses(statuses).map((status) => (
                      <StatusRow
                        key={status.id}
                        status={status}
                        readOnly={readOnly}
                        busy={busyId === status.id}
                        deletable={canDeleteStatus(statuses, status.id)}
                        confirming={confirmDeleteId === status.id}
                        moveTarget={
                          defaultStatusForKind(statuses, status.kind, status.id)?.name ?? null
                        }
                        onRename={(name) => patch(status.id, { name })}
                        onColor={(color) => patch(status.id, { color })}
                        onKind={(kind) => patch(status.id, { kind })}
                        onDefault={() => makeDefault(status.id)}
                        onAskDelete={() => setConfirmDeleteId(status.id)}
                        onCancelDelete={() => setConfirmDeleteId(null)}
                        onDelete={() => handleDelete(status.id)}
                      />
                    ))}
                  </div>
                </SortableContext>
              </DndContext>

              {!readOnly && (
                <div className="grid gap-2 rounded-lg border border-dashed border-border p-3">
                  <Label className="text-muted-foreground">{t("New status")}</Label>
                  <div className="flex flex-wrap gap-1">
                    {TASK_STATUS_COLORS.map((color) => (
                      <button
                        key={color}
                        type="button"
                        onClick={() => setNewColor(color)}
                        aria-label={`${t("Pick color")} ${color}`}
                        className="h-5 w-5 rounded-full border-2 transition-transform hover:scale-110"
                        style={{
                          backgroundColor: color,
                          borderColor: newColor === color ? "var(--foreground)" : "transparent",
                        }}
                      />
                    ))}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Input
                      value={newName}
                      onChange={(e) => setNewName(e.target.value)}
                      placeholder={t("Status name")}
                      className="min-w-[160px] flex-1 border-border bg-muted text-sm text-foreground"
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void handleAdd();
                      }}
                    />
                    <select
                      value={newKind}
                      onChange={(e) => setNewKind(e.target.value as TaskStatusKind)}
                      aria-label={t("Kind")}
                      className={SELECT_CLASS}
                    >
                      {TASK_STATUS_KINDS.map((k) => (
                        <option key={k} value={k}>
                          {t(TASK_STATUS_KIND_LABELS[k])}
                        </option>
                      ))}
                    </select>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void handleAdd()}
                      disabled={adding || !newName.trim()}
                      className="shrink-0 border-border bg-transparent text-muted-foreground hover:bg-muted"
                    >
                      {adding ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3" />}
                      {t("Add")}
                    </Button>
                  </div>
                </div>
              )}

              {readOnly && (
                <p className="text-xs text-muted-foreground">
                  {t("Only account admins can change task statuses.")}
                </p>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </section>
  );
}

function StatusRow({
  status,
  readOnly,
  busy,
  deletable,
  confirming,
  moveTarget,
  onRename,
  onColor,
  onKind,
  onDefault,
  onAskDelete,
  onCancelDelete,
  onDelete,
}: {
  status: TaskStatus;
  readOnly: boolean;
  busy: boolean;
  deletable: boolean;
  confirming: boolean;
  moveTarget: string | null;
  onRename: (name: string) => void;
  onColor: (color: string) => void;
  onKind: (kind: TaskStatusKind) => void;
  onDefault: () => void;
  onAskDelete: () => void;
  onCancelDelete: () => void;
  onDelete: () => void;
}) {
  const { t } = useLanguage();
  const [name, setName] = useState(status.name);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: status.id,
    disabled: readOnly,
  });

  // Mirror server renames (e.g. after a failed save reloads the list).
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setName(status.name);
  }, [status.name]);

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : 1 }}
      className="rounded-lg border border-border bg-muted p-2"
    >
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          {...attributes}
          {...listeners}
          disabled={readOnly}
          className="cursor-grab touch-none text-muted-foreground hover:text-foreground disabled:cursor-default active:cursor-grabbing"
          aria-label={t("Drag to reorder")}
        >
          <GripVertical className="h-4 w-4" />
        </button>

        <label className="relative h-6 w-6 shrink-0 cursor-pointer overflow-hidden rounded-full border border-border" title={t("Color")}>
          <span className="absolute inset-0" style={{ backgroundColor: status.color }} />
          <input
            type="color"
            value={status.color}
            disabled={readOnly}
            onChange={(e) => onColor(e.target.value)}
            className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
            aria-label={t("Color")}
          />
        </label>

        <Input
          value={name}
          disabled={readOnly}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => {
            const trimmed = name.trim();
            if (!trimmed) {
              setName(status.name);
              return;
            }
            if (trimmed !== status.name) onRename(trimmed);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
          className="h-8 min-w-[140px] flex-1 border-border bg-card text-sm text-foreground"
        />

        <select
          value={status.kind}
          disabled={readOnly}
          onChange={(e) => onKind(e.target.value as TaskStatusKind)}
          aria-label={t("Kind")}
          className={SELECT_CLASS}
        >
          {TASK_STATUS_KINDS.map((k) => (
            <option key={k} value={k}>
              {t(TASK_STATUS_KIND_LABELS[k])}
            </option>
          ))}
        </select>

        <button
          type="button"
          onClick={onDefault}
          disabled={readOnly || status.is_default}
          title={status.is_default ? t("Default status for new tasks") : t("Make default")}
          aria-label={status.is_default ? t("Default status for new tasks") : t("Make default")}
          className={cn(
            "flex h-8 w-8 items-center justify-center rounded-lg border transition-colors",
            status.is_default
              ? "border-amber-500/40 bg-amber-500/10 text-amber-500"
              : "border-border text-muted-foreground hover:bg-card hover:text-foreground disabled:opacity-50",
          )}
        >
          <Star className={cn("h-3.5 w-3.5", status.is_default && "fill-current")} />
        </button>

        {!readOnly && (
          <button
            type="button"
            onClick={onAskDelete}
            disabled={!deletable || busy}
            title={deletable ? t("Delete status") : t("Keep at least one status of each kind.")}
            aria-label={t("Delete status")}
            className="flex h-8 w-8 items-center justify-center rounded-lg border border-border text-muted-foreground transition-colors hover:bg-red-500/10 hover:text-red-500 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
          </button>
        )}
      </div>

      {confirming && (
        <div className="mt-2 flex flex-wrap items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/10 p-2 text-xs text-foreground">
          <AlertTriangle className="h-4 w-4 shrink-0 text-red-400" />
          <span className="flex-1">
            {t("Delete this status? Its tasks move to")} <strong>{moveTarget ?? "—"}</strong>.
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onCancelDelete}
            className="h-7 border-border text-muted-foreground hover:bg-muted"
          >
            {t("Cancel")}
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={onDelete}
            disabled={busy}
            className="h-7 bg-red-600 text-white hover:bg-red-700"
          >
            {t("Delete")}
          </Button>
        </div>
      )}
    </div>
  );
}

"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCorners,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
  type UniqueIdentifier,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Plus } from "lucide-react";

import { useLanguage } from "@/hooks/use-language";
import { dndAccessibility } from "@/lib/dnd-accessibility";
import { groupByStatus, sortStatuses, type Task, type TaskMember, type TaskStatus } from "@/lib/tasks";
import { cn } from "@/lib/utils";

import { tasksCopy } from "./copy";
import { TaskCard } from "./task-card";
import { statusName } from "./task-chips";

export interface TaskBoardProps {
  tasks: Task[];
  statuses: TaskStatus[];
  members: TaskMember[];
  onOpen: (task: Task) => void;
  /**
   * Persist a drop: the task now sits in `statusId`, and `orderedIds`
   * is the complete order of that column after the drop.
   */
  onMove: (taskId: string, statusId: string, orderedIds: string[]) => void;
  onAdd?: (statusId: string) => void;
  /** Quick "Concluir" on the cards (writers only). */
  onComplete?: (task: Task) => void;
  readOnly?: boolean;
  compact?: boolean;
}

type Columns = Record<string, string[]>;

function deriveColumns(tasks: Task[], statuses: TaskStatus[]): Columns {
  const groups = groupByStatus(tasks, statuses);
  const out: Columns = {};
  for (const [id, bucket] of groups) out[id] = bucket.map((t) => t.id);
  return out;
}

/**
 * Kanban of the account's statuses. Multi-container sortable: cards
 * reorder inside a column and move across columns (dnd-kit), the
 * order is kept locally while dragging and handed to `onMove` on drop.
 */
export function TaskBoard({
  tasks,
  statuses,
  members,
  onOpen,
  onMove,
  onAdd,
  onComplete,
  readOnly,
  compact,
}: TaskBoardProps) {
  const { language } = useLanguage();
  const sorted = useMemo(() => sortStatuses(statuses), [statuses]);
  const taskById = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);
  const memberById = useMemo(() => new Map(members.map((m) => [m.user_id, m])), [members]);

  const [columns, setColumns] = useState<Columns>(() => deriveColumns(tasks, sorted));
  const [activeId, setActiveId] = useState<string | null>(null);
  const dragging = useRef(false);

  // Mirror the server order whenever the data changes — but never
  // mid-drag, or the card under the pointer would jump back.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (dragging.current) return;
    setColumns(deriveColumns(tasks, sorted));
  }, [tasks, sorted]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    // Space picks a card up, arrows move, Space / Enter drop, Esc cancels.
    // Enter is not a start key so it keeps opening the focused card.
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
      keyboardCodes: { start: ["Space"], cancel: ["Escape"], end: ["Space", "Enter"] },
    }),
  );

  function findColumn(id: UniqueIdentifier): string | null {
    const key = String(id);
    if (key in columns) return key;
    for (const [statusId, ids] of Object.entries(columns)) {
      if (ids.includes(key)) return statusId;
    }
    return null;
  }

  function handleDragStart({ active }: DragStartEvent) {
    dragging.current = true;
    setActiveId(String(active.id));
  }

  function handleDragOver({ active, over }: DragOverEvent) {
    if (!over) return;
    const from = findColumn(active.id);
    const to = findColumn(over.id);
    if (!from || !to || from === to) return;
    setColumns((prev) => {
      const source = prev[from].filter((id) => id !== active.id);
      const target = [...prev[to]];
      const overIndex = target.indexOf(String(over.id));
      const insertAt = overIndex >= 0 ? overIndex : target.length;
      target.splice(insertAt, 0, String(active.id));
      return { ...prev, [from]: source, [to]: target };
    });
  }

  function handleDragEnd({ active, over }: DragEndEvent) {
    dragging.current = false;
    setActiveId(null);
    if (!over) {
      setColumns(deriveColumns(tasks, sorted));
      return;
    }
    const taskId = String(active.id);
    const column = findColumn(over.id) ?? findColumn(active.id);
    if (!column) return;
    const ids = [...columns[column]];
    const fromIndex = ids.indexOf(taskId);
    const overIndex = ids.indexOf(String(over.id));
    const next =
      fromIndex >= 0 && overIndex >= 0 && fromIndex !== overIndex
        ? arrayMove(ids, fromIndex, overIndex)
        : ids;
    setColumns((prev) => ({ ...prev, [column]: next }));

    const original = taskById.get(taskId);
    const originalOrder = deriveColumns(tasks, sorted)[column] ?? [];
    const unchanged =
      original?.status_id === column &&
      originalOrder.length === next.length &&
      originalOrder.every((id, i) => id === next[i]);
    if (!unchanged) onMove(taskId, column, next);
  }

  function handleDragCancel() {
    dragging.current = false;
    setActiveId(null);
    setColumns(deriveColumns(tasks, sorted));
  }

  const activeTask = activeId ? taskById.get(activeId) ?? null : null;

  return (
    <DndContext
      accessibility={dndAccessibility(language)}
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
    >
      <div className="flex snap-x snap-mandatory scroll-px-4 gap-2.5 overflow-x-auto pb-3 lg:snap-none board-fit:min-h-0 board-fit:flex-1">
        {sorted.map((status) => {
          const ids = columns[status.id] ?? [];
          const columnTasks = ids
            .map((id) => taskById.get(id))
            .filter((t): t is Task => !!t);
          return (
            <BoardColumn
              key={status.id}
              status={status}
              tasks={columnTasks}
              memberById={memberById}
              onOpen={onOpen}
              onAdd={onAdd}
              onComplete={onComplete}
              readOnly={readOnly}
              compact={compact}
            />
          );
        })}
      </div>

      <DragOverlay dropAnimation={{ duration: 200, easing: "cubic-bezier(0.2, 0, 0, 1)" }}>
        {activeTask ? (
          <div>
            <TaskCard
              compact={compact}
              task={activeTask}
              status={sorted.find((s) => s.id === (findColumn(activeTask.id) ?? activeTask.status_id)) ?? null}
              assignee={
                activeTask.assignee_user_id
                  ? memberById.get(activeTask.assignee_user_id) ?? null
                  : null
              }
              onOpen={() => {}}
              isOverlay
            />
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

function BoardColumn({
  status,
  tasks,
  memberById,
  onOpen,
  onAdd,
  onComplete,
  readOnly,
  compact,
}: {
  status: TaskStatus;
  tasks: Task[];
  memberById: Map<string, TaskMember>;
  onOpen: (task: Task) => void;
  onAdd?: (statusId: string) => void;
  onComplete?: (task: Task) => void;
  readOnly?: boolean;
  compact?: boolean;
}) {
  const { language } = useLanguage();
  const copy = tasksCopy(language);
  // Droppable on the card list, not the header (a drag over the header
  // does not tint it) — same as the pipelines board.
  const { setNodeRef, isOver } = useDroppable({ id: status.id });
  const name = statusName(status, language);
  const canAdd = !!onAdd && !readOnly;

  return (
    <section
      aria-label={copy.column(name, tasks.length)}
      className="flex w-[85vw] min-w-[260px] max-w-[320px] shrink-0 snap-start flex-col rounded-[var(--radius)] bg-muted/45 board-fit:min-h-0 lg:w-auto lg:min-w-[220px] lg:max-w-none lg:flex-1 lg:basis-[220px] lg:shrink lg:snap-none dark:bg-muted/30"
    >
      <header className="flex items-center gap-2 border-b border-border/70 px-3 py-2.5">
        <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ backgroundColor: status.color }} />
        <h3 className="min-w-0 truncate text-[13px] font-semibold text-foreground" data-no-translate>
          {name}
        </h3>
        <span className="shrink-0 rounded-full bg-background px-1.5 py-px text-[11px] font-semibold tabular-nums text-muted-foreground">
          {tasks.length}
        </span>
        {canAdd && (
          <button
            type="button"
            onClick={() => onAdd!(status.id)}
            aria-label={copy.addTo(name)}
            title={copy.add}
            className="-mr-1 ml-auto inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-background hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
          >
            <Plus className="size-3.5" aria-hidden />
          </button>
        )}
      </header>

      <SortableContext items={tasks.map((task) => task.id)} strategy={verticalListSortingStrategy}>
        <div
          ref={setNodeRef}
          data-over={isOver || undefined}
          className={cn(
            "flex flex-1 flex-col rounded-b-[var(--radius)] p-2 transition-colors duration-150 motion-reduce:transition-none board-fit:min-h-0 board-fit:overflow-y-auto",
            compact ? "gap-1" : "gap-1.5",
            isOver && "bg-primary/8 ring-1 ring-inset ring-primary/35",
          )}
        >
          {tasks.length === 0 ? (
            <div className="flex flex-1 flex-col items-start gap-1 px-1.5 py-3 text-xs text-muted-foreground">
              <p>{isOver ? copy.dropHere : copy.emptyColumn}</p>
              {canAdd && !isOver && (
                <button
                  type="button"
                  onClick={() => onAdd!(status.id)}
                  className="inline-flex items-center gap-1 rounded-sm font-medium text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <Plus className="size-3" aria-hidden />
                  {copy.add}
                </button>
              )}
            </div>
          ) : (
            tasks.map((task) => (
              <SortableTaskCard
                key={task.id}
                task={task}
                status={status}
                assignee={task.assignee_user_id ? memberById.get(task.assignee_user_id) ?? null : null}
                onOpen={onOpen}
                onComplete={onComplete}
                disabled={readOnly}
                compact={compact}
              />
            ))
          )}
        </div>
      </SortableContext>
    </section>
  );
}

function SortableTaskCard({
  task,
  status,
  assignee,
  onOpen,
  onComplete,
  disabled,
  compact,
}: {
  task: Task;
  status: TaskStatus;
  assignee: TaskMember | null;
  onOpen: (task: Task) => void;
  onComplete?: (task: Task) => void;
  disabled?: boolean;
  compact?: boolean;
}) {
  // The card's main button is the drag handle (activator), so the
  // quick-action buttons never start a drag.
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } =
    useSortable({ id: task.id, disabled });
  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Translate.toString(transform),
        transition,
        opacity: isDragging ? 0.4 : 1,
      }}
    >
      <TaskCard
        task={task}
        status={status}
        assignee={assignee}
        onOpen={onOpen}
        onComplete={onComplete}
        dragging={isDragging}
        compact={compact}
        handleRef={setActivatorNodeRef}
        handleProps={{ ...attributes, ...listeners }}
      />
    </div>
  );
}

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
import { groupByStatus, sortStatuses, type Task, type TaskMember, type TaskStatus } from "@/lib/tasks";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { TaskCard } from "./task-card";

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
  readOnly?: boolean;
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
  readOnly,
}: TaskBoardProps) {
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
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
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
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
    >
      <div className="flex snap-x snap-mandatory gap-3 overflow-x-auto pb-4 lg:snap-none board-fit:min-h-0 board-fit:flex-1">
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
              readOnly={readOnly}
            />
          );
        })}
      </div>

      <DragOverlay dropAnimation={{ duration: 200, easing: "cubic-bezier(0.2, 0, 0, 1)" }}>
        {activeTask ? (
          <div className="opacity-90">
            <TaskCard
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
  readOnly,
}: {
  status: TaskStatus;
  tasks: Task[];
  memberById: Map<string, TaskMember>;
  onOpen: (task: Task) => void;
  onAdd?: (statusId: string) => void;
  readOnly?: boolean;
}) {
  const { t } = useLanguage();
  const { setNodeRef, isOver } = useDroppable({ id: status.id });

  return (
    <div className="flex w-[85vw] min-w-[260px] max-w-[320px] shrink-0 snap-start flex-col rounded-xl border border-border bg-card/60 p-4 board-fit:min-h-0 lg:w-auto lg:min-w-[220px] lg:max-w-none lg:flex-1 lg:basis-[220px] lg:shrink lg:snap-none">
      <div className="-mx-4 -mt-4 h-[3px] rounded-t-xl" style={{ backgroundColor: status.color }} />
      <div className="flex items-center justify-between pt-3">
        <h3 className="truncate text-sm font-semibold text-foreground">{status.name}</h3>
        <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
          {tasks.length}
        </span>
      </div>

      <SortableContext items={tasks.map((task) => task.id)} strategy={verticalListSortingStrategy}>
        <div
          ref={setNodeRef}
          className={cn(
            "mt-3 flex flex-1 flex-col gap-2 rounded-lg transition-all board-fit:min-h-0 board-fit:overflow-y-auto",
            isOver && "bg-primary/5 outline outline-2 outline-dashed outline-primary outline-offset-2",
          )}
        >
          {tasks.length === 0 ? (
            <div className="flex flex-1 items-center justify-center rounded-lg border-2 border-dashed border-border py-10 text-xs text-muted-foreground">
              {t("Drop a task here")}
            </div>
          ) : (
            tasks.map((task) => (
              <SortableTaskCard
                key={task.id}
                task={task}
                status={status}
                assignee={task.assignee_user_id ? memberById.get(task.assignee_user_id) ?? null : null}
                onOpen={onOpen}
                disabled={readOnly}
              />
            ))
          )}
        </div>
      </SortableContext>

      {onAdd && !readOnly && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onAdd(status.id)}
          className="mt-3 w-full justify-start border border-dashed border-border bg-transparent text-muted-foreground hover:border-border hover:bg-muted hover:text-foreground"
        >
          <Plus className="mr-1 h-3 w-3" />
          {t("Add task")}
        </Button>
      )}
    </div>
  );
}

function SortableTaskCard({
  task,
  status,
  assignee,
  onOpen,
  disabled,
}: {
  task: Task;
  status: TaskStatus;
  assignee: TaskMember | null;
  onOpen: (task: Task) => void;
  disabled?: boolean;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: task.id,
    disabled,
  });
  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      style={{
        transform: CSS.Translate.toString(transform),
        transition,
        opacity: isDragging ? 0.3 : 1,
        touchAction: "none",
      }}
    >
      <TaskCard task={task} status={status} assignee={assignee} onOpen={onOpen} />
    </div>
  );
}

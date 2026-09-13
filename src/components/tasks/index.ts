// ============================================================
// Tasks UI — public components.
//
//   <TaskDrawer>       create / edit sheet (comments, complete, delete)
//   <TaskQuickCreate>  inline "title + due" creator for side panels
//   <LinkedTaskRows>   panel rows (checkbox + title + due) + useLinkedTasks
//   <TaskList>         rows with the complete checkbox
//   <TaskBoard>        dnd-kit kanban over the account's statuses
//   <TaskFilters>      chips + selects + Lista | Quadro toggle
//   chips              PriorityChip, StatusChip, DueChip, AssigneeAvatar, TaskLinkChip
//   hooks              useTaskStatuses, useTaskMembers, useTasksRealtime
// ============================================================

export { TaskDrawer, type TaskDrawerProps } from './task-drawer';
export { TaskQuickCreate, type TaskQuickCreateProps } from './task-quick-create';
export {
  LinkedTaskRows,
  useLinkedTasks,
  type LinkedTaskRowsProps,
  type LinkedTasksState,
  type UseLinkedTasksOptions,
} from './linked-tasks';
export { TaskList, type TaskListProps } from './task-list';
export { TaskBoard, type TaskBoardProps } from './task-board';
export { TaskCard, type TaskCardProps } from './task-card';
export { TaskFilters, type TaskFiltersProps, type TaskView } from './task-filters';
export {
  AssigneeAvatar,
  DueChip,
  PRIORITY_LABELS,
  PriorityChip,
  StatusChip,
  TaskLinkChip,
  memberLabel,
} from './task-chips';
export { useTaskMembers, useTaskStatuses, useTasksRealtime } from './hooks';

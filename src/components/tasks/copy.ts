import type { Language } from "@/lib/i18n";

/** Copy for the restyled Tarefas screen (own object, not the shared catalogue). */
export const TASKS_UI_COPY = {
  "pt-BR": {
    title: "Tarefas",
    compact: "Lista compacta",
    overdue: (n: number) => (n === 1 ? "1 atrasada" : `${n} atrasadas`),
    open: (name: string) => `Abrir ${name}`,
    complete: "Concluir",
    completeAria: (name: string) => `Concluir ${name}`,
    toolbar: (name: string) => `Ações da tarefa ${name}`,
    add: "Nova tarefa",
    addTo: (status: string) => `Nova tarefa em ${status}`,
    column: (status: string, n: number) => `${status}, ${n} ${n === 1 ? "tarefa" : "tarefas"}`,
    emptyColumn: "Nenhuma tarefa.",
    dropHere: "Solte aqui",
  },
  "en-US": {
    title: "Tasks",
    compact: "Compact list",
    overdue: (n: number) => `${n} overdue`,
    open: (name: string) => `Open ${name}`,
    complete: "Complete",
    completeAria: (name: string) => `Complete ${name}`,
    toolbar: (name: string) => `Actions for task ${name}`,
    add: "New task",
    addTo: (status: string) => `New task in ${status}`,
    column: (status: string, n: number) => `${status}, ${n} ${n === 1 ? "task" : "tasks"}`,
    emptyColumn: "No tasks.",
    dropHere: "Drop here",
  },
} satisfies Record<Language, Record<string, unknown>>;

export type TasksUiCopy = (typeof TASKS_UI_COPY)["pt-BR"];

export function tasksCopy(language: Language): TasksUiCopy {
  return TASKS_UI_COPY[language] ?? TASKS_UI_COPY["pt-BR"];
}

import { describe, expect, it, vi } from "vitest"
import { renderToString } from "react-dom/server"

import { TaskQuickCreate } from "./task-quick-create"
import { TaskList } from "./task-list"
import type { Task, TaskStatus } from "@/lib/tasks"

// Client components rendered to a string: exercises the markup and the
// pt-BR copy (useLanguage falls back to the default catalogue without a
// provider). Effects never run here, so no Supabase call is made.
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    from: () => {
      throw new Error("from() must only be called from handlers")
    },
  }),
}))

const statuses: TaskStatus[] = [
  {
    id: "todo",
    account_id: "acc",
    name: "A fazer",
    color: "#3b82f6",
    position: 0,
    kind: "open",
    is_default: true,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  },
  {
    id: "done",
    account_id: "acc",
    name: "Concluída",
    color: "#22c55e",
    position: 1,
    kind: "done",
    is_default: false,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  },
]

const task = (overrides: Partial<Task>): Task => ({
  id: "t1",
  account_id: "acc",
  status_id: "todo",
  title: "Ligar para o cliente",
  description: null,
  priority: "normal",
  assignee_user_id: null,
  created_by: null,
  contact_id: null,
  conversation_id: null,
  deal_id: null,
  due_at: null,
  completed_at: null,
  position: 0,
  created_at: "2026-09-01T00:00:00Z",
  updated_at: "2026-09-01T00:00:00Z",
  ...overrides,
})

describe("TaskQuickCreate", () => {
  it("renders the pt-BR placeholder, Cancelar and Adicionar tarefa", () => {
    const html = renderToString(
      <TaskQuickCreate statuses={statuses} onCancel={() => {}} defaults={{ contact_id: "c1" }} />,
    )
    expect(html).toContain("O que precisa ser feito?")
    expect(html).toContain(">Cancelar<")
    expect(html).toContain(">Adicionar tarefa<")
    // Nothing typed yet → the save button is disabled.
    expect(html).toMatch(/Adicionar tarefa<\/button>/)
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Adicionar tarefa/)
  })
})

describe("TaskList", () => {
  it("renders rows with status chips and the empty state", () => {
    const html = renderToString(
      <TaskList
        tasks={[
          task({ id: "a", title: "Enviar proposta", priority: "high" }),
          task({ id: "b", title: "Feita", status_id: "done" }),
        ]}
        statuses={statuses}
        members={[]}
        onOpen={() => {}}
        onToggleDone={() => {}}
      />,
    )
    expect(html).toContain("Enviar proposta")
    expect(html).toContain("A fazer")
    expect(html).toContain("Alta")
    expect(html).toContain("line-through")

    const empty = renderToString(
      <TaskList tasks={[]} statuses={statuses} members={[]} onOpen={() => {}} onToggleDone={() => {}} />,
    )
    expect(empty).toContain("Nenhuma tarefa aqui")
  })
})

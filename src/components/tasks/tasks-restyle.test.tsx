// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"

import type { Task, TaskStatus } from "@/lib/tasks"
import { densityKey, readDensity, writeDensity } from "./density"
import { TaskCard } from "./task-card"
import { TaskList } from "./task-list"
import { DueChip } from "./task-chips"

afterEach(() => {
  cleanup()
  localStorage.clear()
})

const open: TaskStatus = {
  id: "todo",
  account_id: "acc",
  name: "A fazer",
  color: "#3b82f6",
  position: 0,
  kind: "open",
  is_default: true,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
}
const done: TaskStatus = { ...open, id: "done", name: "Concluída", kind: "done", is_default: false }

const task = (overrides: Partial<Task> = {}): Task => ({
  id: "t1",
  account_id: "acc",
  status_id: "todo",
  title: "Enviar proposta",
  description: "Detalhes",
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

describe("density persistence", () => {
  it("is per area and per user, defaulting to comfortable", () => {
    expect(densityKey("tasks", "u1")).toBe("sempre:tasks:density:u1")
    expect(readDensity("tasks", "u1")).toBe("comfortable")
    writeDensity("tasks", "u1", "compact")
    expect(readDensity("tasks", "u1")).toBe("compact")
    expect(readDensity("tasks", "u2")).toBe("comfortable")
    expect(readDensity("chat", "u1")).toBe("comfortable")
  })

  it("falls back when storage throws", () => {
    const spy = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked")
    })
    expect(readDensity("agenda", "u1")).toBe("comfortable")
    spy.mockRestore()
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked")
    })
    expect(() => writeDensity("agenda", "u1", "compact")).not.toThrow()
    vi.restoreAllMocks()
  })
})

describe("TaskList", () => {
  it("opens from the title button and hides the description when compact", () => {
    const onOpen = vi.fn()
    const { rerender } = render(
      <TaskList tasks={[task()]} statuses={[open]} members={[]} onOpen={onOpen} onToggleDone={() => {}} />,
    )
    expect(screen.getByText("Detalhes")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Abrir Enviar proposta" }))
    expect(onOpen).toHaveBeenCalledTimes(1)

    rerender(
      <TaskList tasks={[task()]} statuses={[open]} members={[]} onOpen={onOpen} onToggleDone={() => {}} compact />,
    )
    expect(screen.queryByText("Detalhes")).toBeNull()
  })
})

describe("TaskCard quick actions", () => {
  it("completes an open task and hides Concluir on a done one", () => {
    const onComplete = vi.fn()
    const { rerender } = render(
      <TaskCard task={task()} status={open} assignee={null} onOpen={() => {}} onComplete={onComplete} />,
    )
    fireEvent.click(screen.getByRole("button", { name: "Concluir Enviar proposta" }))
    expect(onComplete).toHaveBeenCalledWith(expect.objectContaining({ id: "t1" }))

    rerender(<TaskCard task={task()} status={done} assignee={null} onOpen={() => {}} onComplete={onComplete} />)
    expect(screen.queryByRole("button", { name: "Concluir Enviar proposta" })).toBeNull()
  })

  it("has no quick toolbar while dragging or as the overlay", () => {
    render(<TaskCard task={task()} status={open} assignee={null} onOpen={() => {}} isOverlay />)
    expect(screen.queryByTestId("task-quick-actions")).toBeNull()
  })
})

describe("DueChip", () => {
  it("marks an overdue date with a red dot, a done one without urgency", () => {
    const past = new Date(Date.now() - 3 * 86_400_000).toISOString()
    const { container, rerender } = render(<DueChip dueAt={past} />)
    expect(container.querySelector(".bg-red-500")).not.toBeNull()
    rerender(<DueChip dueAt={past} done />)
    expect(container.querySelector(".bg-red-500")).toBeNull()
    expect(container.innerHTML).toContain("line-through")
  })
})

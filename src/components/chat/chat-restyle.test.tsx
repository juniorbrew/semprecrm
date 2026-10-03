// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"

import type { ChatListRow } from "@/lib/chat"
import type { ChatMessage } from "@/types"
import { PeopleList } from "./people-list"
import { SystemLine } from "./system-line"

afterEach(cleanup)

const person = (id: string, name: string, unread = 0): ChatListRow => ({
  kind: "person",
  key: `p:${id}`,
  row: {
    member: { user_id: id, full_name: name, email: `${id}@x.dev`, avatar_url: null, last_seen_at: null },
    thread: null,
    unread,
    lastMessageAt: null,
    preview: "Oi",
  },
})

function renderList(compact = false) {
  return render(
    <PeopleList
      rows={[person("u1", "Ana", 3), person("u2", "Bia")]}
      loading={false}
      selectedKey="p:u2"
      isOnline={(id) => id === "u1"}
      now={Date.now()}
      onSelect={() => {}}
      onNewGroup={() => {}}
      compact={compact}
    />,
  )
}

describe("PeopleList", () => {
  it("marks the selected row with the soft tint + accent and aria-current", () => {
    renderList()
    const selected = screen.getByText("Bia").closest("button")!
    expect(selected.getAttribute("aria-current")).toBe("true")
    expect(selected.className).toContain("bg-primary/10")
    expect(selected.className).toContain("inset_3px_0_0_var(--primary)")
    const other = screen.getByText("Ana").closest("button")!
    expect(other.className).not.toContain("bg-primary/10")
  })

  it("keeps the unread pill as the only filled element and shrinks rows when compact", () => {
    const { container } = renderList(true)
    expect(container.querySelectorAll(".bg-primary")).toHaveLength(1)
    expect(container.querySelector(".size-8")).not.toBeNull()
    expect(container.querySelector(".size-10")).toBeNull()
  })
})

describe("SystemLine", () => {
  it("renders the event between two hairlines", () => {
    const message = {
      id: "m1",
      thread_id: "t1",
      sender_id: "u1",
      kind: "system",
      body: JSON.stringify({ event: "created" }),
    } as unknown as ChatMessage
    const { container } = render(<SystemLine message={message} userId="u2" nameOf={() => "Ana"} />)
    expect(container.textContent).toContain("Ana")
    expect(container.querySelectorAll(".h-px")).toHaveLength(2)
  })
})

// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest"
import { cleanup, render } from "@testing-library/react"

import { gridFor, type CalendarEvent } from "@/lib/calendar"
import { MonthView } from "./month-view"

afterEach(cleanup)

const TZ = "America/Sao_Paulo"
const anchor = new Date("2026-09-15T15:00:00Z")

const ev = (id: string, hour: number): CalendarEvent => ({
  id,
  account_id: "acc",
  owner_user_id: "u1",
  title: `Reunião ${id}`,
  description: null,
  location: null,
  color: null,
  starts_at: new Date(Date.UTC(2026, 8, 15, hour)).toISOString(),
  ends_at: new Date(Date.UTC(2026, 8, 15, hour + 1)).toISOString(),
  all_day: false,
  status: "confirmed",
  reminder_minutes: null,
  reminded_at: null,
  contact_id: null,
  conversation_id: null,
  deal_id: null,
  task_id: null,
  chat_thread_id: null,
  source: "internal",
  external_connection_id: null,
  external_id: null,
  external_etag: null,
  external_updated_at: null,
  sync_hash: null,
  created_by: null,
  created_at: "2026-09-01T00:00:00Z",
  updated_at: "2026-09-01T00:00:00Z",
})

function renderMonth(compact: boolean) {
  const days = gridFor("month", anchor, TZ, anchor)
  const events = [ev("a", 12), ev("b", 13), ev("c", 14), ev("d", 15)]
  return render(
    <MonthView
      days={days}
      events={events}
      tz={TZ}
      compact={compact}
      onOpenEvent={() => {}}
      onCreateAt={() => {}}
      onMoveEvent={() => {}}
      onShowDay={() => {}}
    />,
  )
}

describe("MonthView density", () => {
  it("shows three chips per day comfortable, two compact, the rest behind +N", () => {
    const { container, unmount } = renderMonth(false)
    expect(container.querySelectorAll("[data-event-id]")).toHaveLength(3)
    expect(container.querySelector("[data-more]")?.textContent).toContain("+1")
    unmount()

    const compact = renderMonth(true)
    expect(compact.container.querySelectorAll("[data-event-id]")).toHaveLength(2)
    expect(compact.container.querySelector("[data-more]")?.textContent).toContain("+2")
  })

  it("marks today with a soft brand tint, not a filled circle", () => {
    const { container } = renderMonth(false)
    expect(container.querySelector(".bg-primary\\/15")?.textContent).toBe("15")
  })
})

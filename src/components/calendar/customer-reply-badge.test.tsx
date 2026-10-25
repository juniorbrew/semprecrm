// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"

import { CustomerReplyBadge } from "./event-chip"

afterEach(cleanup)

describe("CustomerReplyBadge", () => {
  it("shows what the customer answered to the reminder", () => {
    const { rerender } = render(<CustomerReplyBadge event={{ customer_response: "confirmed" }} />)
    expect(screen.getByTestId("customer-reply-badge").getAttribute("title")).toBe("Confirmado pelo cliente")
    expect(screen.getByText("Confirmado pelo cliente")).toBeTruthy() // screen-reader text
    rerender(<CustomerReplyBadge event={{ customer_response: "reschedule_requested" }} />)
    expect(screen.getByTestId("customer-reply-badge").getAttribute("title")).toBe("Pediu para remarcar")
  })

  it("renders nothing without an answer", () => {
    const { container, rerender } = render(<CustomerReplyBadge event={{ customer_response: null }} />)
    expect(container.firstChild).toBeNull()
    rerender(<CustomerReplyBadge event={{}} />)
    expect(container.firstChild).toBeNull()
  })
})

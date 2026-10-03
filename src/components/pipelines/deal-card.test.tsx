// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"

vi.mock("@/hooks/use-language", () => ({
  useLanguage: () => ({ language: "pt-BR", t: (s: string) => s }),
}))

import type { Deal, PipelineStage } from "@/types"
import { DealCard } from "./deal-card"

const stage = { id: "s1", pipeline_id: "p", name: "Proposta", color: "#f97316", position: 0 } as PipelineStage
const deal = (over: Partial<Deal> = {}): Deal =>
  ({
    id: "d1",
    user_id: "u",
    pipeline_id: "p",
    stage_id: "s1",
    contact_id: "k",
    title: "Contrato anual",
    value: 1500,
    currency: "BRL",
    status: "open",
    created_at: "2026-09-30T10:00:00Z",
    contact: { id: "k", name: "Marina Souza" },
    company: { id: "c", razao_social: "ACME Ltda", nome_fantasia: "ACME" },
    ...over,
  }) as Deal

afterEach(cleanup)

describe("DealCard", () => {
  it("opens from the main button, labelled with title, value and stage", () => {
    const onEdit = vi.fn()
    render(<DealCard deal={deal()} stage={stage} onEdit={onEdit} />)
    const main = screen.getByRole("button", { name: /^Contrato anual · R\$\s1\.500 · Proposta/ })
    fireEvent.click(main)
    expect(onEdit).toHaveBeenCalledTimes(1)
    expect(screen.getByText("Marina Souza · ACME")).toBeTruthy()
  })

  it("offers won / lost quick actions only with a handler and while open", () => {
    const onStatus = vi.fn()
    const { rerender } = render(<DealCard deal={deal()} stage={stage} onEdit={vi.fn()} onStatus={onStatus} />)
    fireEvent.click(screen.getByRole("button", { name: "Marcar Contrato anual como ganho" }))
    fireEvent.click(screen.getByRole("button", { name: "Marcar Contrato anual como perdido" }))
    expect(onStatus.mock.calls.map((c) => c[1])).toEqual(["won", "lost"])

    rerender(<DealCard deal={deal()} stage={stage} onEdit={vi.fn()} />)
    expect(screen.queryByRole("button", { name: /como ganho/ })).toBeNull()
    expect(screen.getByRole("button", { name: "Abrir negócio Contrato anual" })).toBeTruthy()

    rerender(<DealCard deal={deal({ status: "won" })} stage={stage} onEdit={vi.fn()} onStatus={onStatus} />)
    expect(screen.queryByRole("button", { name: /como ganho/ })).toBeNull()
    expect(screen.getByText("Ganho")).toBeTruthy()
  })

  it("compact drops the contact line; the overlay has no quick actions", () => {
    render(<DealCard deal={deal()} stage={stage} onEdit={vi.fn()} compact isOverlay />)
    expect(screen.queryByText(/Marina Souza/)).toBeNull()
    expect(screen.queryByTestId("deal-quick-actions")).toBeNull()
  })

  it("shows the stage accent only when the stage has a colour", () => {
    const { container, rerender } = render(<DealCard deal={deal()} stage={stage} onEdit={vi.fn()} />)
    expect(container.querySelector("[style*='background-color']")).toBeTruthy()
    rerender(<DealCard deal={deal()} stage={{ ...stage, color: "" }} onEdit={vi.fn()} />)
    expect(container.querySelector("[style*='background-color']")).toBeNull()
  })
})

// @vitest-environment jsdom
// The value of a deal with product lines is calculated by the database: the form
// shows it read-only and never sends it.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"

import type { Deal, PipelineStage } from "@/types"

const h = vi.hoisted(() => ({ updates: [] as Record<string, unknown>[], count: 0 }))

vi.mock("@/hooks/use-language", () => ({
  useLanguage: () => ({ language: "pt-BR", t: (s: string) => s }),
}))
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ accountId: "acc-1", defaultCurrency: "BRL" }),
  useEntitlements: () => ({ ready: true, modules: { pipelines: false } }),
}))
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock("@/lib/audit-client", () => ({ recordAudit: vi.fn() }))
vi.mock("@/lib/companies", () => ({ getPrimaryCompany: vi.fn(async () => null) }))
vi.mock("@/components/companies/deal-company-field", () => ({ DealCompanyField: () => null }))
vi.mock("@/lib/products/data", () => ({ countDealItems: vi.fn(async () => h.count) }))
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    from: () => {
      const b: Record<string, unknown> = {}
      b.select = () => b
      b.order = () => Promise.resolve({ data: [] })
      b.update = (payload: Record<string, unknown>) => {
        h.updates.push(payload)
        return { eq: () => Promise.resolve({ error: null }) }
      }
      return b
    },
  }),
}))

import { DealFormBody } from "./deal-form"

const stage = { id: "s1", pipeline_id: "p", name: "Proposta", color: "#f97316", position: 0 } as PipelineStage
const deal = {
  id: "d1",
  user_id: "u",
  pipeline_id: "p",
  stage_id: "s1",
  contact_id: "k",
  title: "Contrato anual",
  value: 245,
  currency: "BRL",
  status: "open",
  created_at: "2026-09-30T10:00:00Z",
} as Deal

beforeEach(() => {
  h.updates = []
  h.count = 0
})
afterEach(cleanup)

function renderForm() {
  const onSaved = vi.fn()
  render(<DealFormBody deal={deal} pipelineId="p" stages={[stage]} onSaved={onSaved} onCancel={vi.fn()} />)
  return onSaved
}

describe("DealFormBody value", () => {
  it("is read-only with a hint when the deal has product lines, and the save does not send it", async () => {
    h.count = 2
    const onSaved = renderForm()
    const value = (await screen.findByLabelText("Value")) as HTMLInputElement
    await waitFor(() => expect(value.readOnly).toBe(true))
    expect(value.value).toBe("245")
    expect(screen.getByText("calculated from the items")).toBeTruthy()
    expect(value.getAttribute("aria-describedby")).toBe(screen.getByText("calculated from the items").id)

    fireEvent.change(screen.getByDisplayValue("Contrato anual"), { target: { value: "Contrato anual 2" } })
    fireEvent.click(screen.getByRole("button", { name: /Save/ }))
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    expect(h.updates).toHaveLength(1)
    expect(h.updates[0]).toMatchObject({ title: "Contrato anual 2" })
    expect("value" in h.updates[0]).toBe(false)
  })

  it("stays editable, and is sent, when the deal has no lines", async () => {
    h.count = 0
    const onSaved = renderForm()
    const value = (await screen.findByLabelText("Value")) as HTMLInputElement
    expect(value.readOnly).toBe(false)
    expect(screen.queryByText("calculated from the items")).toBeNull()
    fireEvent.change(value, { target: { value: "300" } })
    fireEvent.click(screen.getByRole("button", { name: /Save/ }))
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    expect(h.updates[0]).toMatchObject({ value: 300 })
  })
})

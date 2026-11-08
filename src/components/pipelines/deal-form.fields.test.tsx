// @vitest-environment jsdom
// Deal fields (migration 107) in the deal form: number boxes, only changed values are written,
// a bad number blocks the save, a new deal gets its id so the values can be stored.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"

import type { DealField } from "@/lib/deal-fields/types"
import type { Deal, PipelineStage } from "@/types"

const h = vi.hoisted(() => ({
  updates: [] as Record<string, unknown>[],
  inserts: [] as Record<string, unknown>[],
  pipelines: true,
}))

vi.mock("@/hooks/use-language", () => ({
  useLanguage: () => ({ language: "pt-BR", t: (s: string) => s }),
}))
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ accountId: "acc-1", defaultCurrency: "BRL" }),
  useEntitlements: () => ({ ready: true, modules: { pipelines: h.pipelines } }),
}))
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock("@/lib/audit-client", () => ({ recordAudit: vi.fn() }))
vi.mock("@/lib/companies", () => ({ getPrimaryCompany: vi.fn(async () => null) }))
vi.mock("@/components/companies/deal-company-field", () => ({ DealCompanyField: () => null }))
vi.mock("@/lib/products/data", () => ({ countDealItems: vi.fn(async () => 0) }))
vi.mock("@/lib/deal-fields/events", () => ({ notifyDealFieldsChanged: vi.fn(), onDealFieldsChanged: vi.fn() }))
vi.mock("@/lib/deal-fields/data", () => ({
  listDealFields: vi.fn(),
  listDealFieldValues: vi.fn(),
  setDealFieldValue: vi.fn(),
}))
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    auth: { getSession: async () => ({ data: { session: { user: { id: "u1" } } } }) },
    from: () => {
      const b: Record<string, unknown> = {}
      b.select = () => b
      b.order = () => Promise.resolve({ data: [{ id: "k", name: "Marina", phone: "1" }] })
      b.update = (payload: Record<string, unknown>) => {
        h.updates.push(payload)
        return { eq: () => Promise.resolve({ error: null }) }
      }
      b.insert = (payload: Record<string, unknown>) => {
        h.inserts.push(payload)
        return Promise.resolve({ error: null })
      }
      return b
    },
  }),
}))

import { listDealFields, listDealFieldValues, setDealFieldValue } from "@/lib/deal-fields/data"
import { notifyDealFieldsChanged } from "@/lib/deal-fields/events"
import { toast } from "sonner"
import { DealFormBody } from "./deal-form"

const stage = { id: "s1", pipeline_id: "p", name: "Proposta", position: 0 } as PipelineStage
const deal = {
  id: "d1", user_id: "u", pipeline_id: "p", stage_id: "s1", contact_id: "k",
  title: "Contrato", value: 100, currency: "BRL", status: "open", created_at: "2026-09-30T10:00:00Z",
} as Deal
const base = { account_id: "acc-1", expression: null, result_format: null, show_on_card: false } as const
const FIELDS: DealField[] = [
  { ...base, id: "f1", name: "Custo", kind: "currency", position: 0 },
  { ...base, id: "f2", name: "% comissão", kind: "percent", position: 1 },
  { ...base, id: "f3", name: "Margem", kind: "formula", expression: "{valor}", result_format: "number", position: 2 },
]

beforeEach(() => {
  h.updates = []
  h.inserts = []
  h.pipelines = true
  vi.mocked(listDealFields).mockResolvedValue(FIELDS)
  vi.mocked(listDealFieldValues).mockResolvedValue({ f1: 500 })
  vi.mocked(setDealFieldValue).mockResolvedValue(undefined)
})
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

async function editForm(onSaved = vi.fn()) {
  render(<DealFormBody deal={deal} pipelineId="p" stages={[stage]} onSaved={onSaved} onCancel={vi.fn()} />)
  const custo = (await screen.findByLabelText("Custo")) as HTMLInputElement
  await waitFor(() => expect(custo.value).toBe("500"))
  return { custo, onSaved }
}

describe("DealFormBody deal fields", () => {
  it("shows a box per number field with the current value, none for formulas", async () => {
    await editForm()
    expect((screen.getByLabelText("% comissão") as HTMLInputElement).value).toBe("")
    expect(screen.queryByLabelText("Margem")).toBeNull()
  })

  it("writes only what changed, after the deal itself", async () => {
    const { onSaved } = await editForm()
    fireEvent.change(screen.getByLabelText("% comissão"), { target: { value: "5,5" } })
    fireEvent.click(screen.getByRole("button", { name: /Save/ }))
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    expect(h.updates).toHaveLength(1)
    expect(setDealFieldValue).toHaveBeenCalledTimes(1)
    expect(setDealFieldValue).toHaveBeenCalledWith(expect.anything(), "acc-1", "d1", "f2", 5.5)
    expect(notifyDealFieldsChanged).toHaveBeenCalled()
  })

  it("clears a value when the box is emptied", async () => {
    const { custo, onSaved } = await editForm()
    fireEvent.change(custo, { target: { value: "" } })
    fireEvent.click(screen.getByRole("button", { name: /Save/ }))
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    expect(setDealFieldValue).toHaveBeenCalledWith(expect.anything(), "acc-1", "d1", "f1", null)
  })

  it("a box that is not a number blocks the whole save", async () => {
    const { custo, onSaved } = await editForm()
    fireEvent.change(custo, { target: { value: "abc" } })
    fireEvent.click(screen.getByRole("button", { name: /Save/ }))
    expect(await screen.findByText("Type a valid number, like 12,5")).toBeTruthy()
    expect(custo.getAttribute("aria-invalid")).toBe("true")
    expect(h.updates).toHaveLength(0)
    expect(setDealFieldValue).not.toHaveBeenCalled()
    expect(onSaved).not.toHaveBeenCalled()
  })

  it("a new deal is inserted with a chosen id so its values can be stored", async () => {
    const onSaved = vi.fn()
    render(<DealFormBody pipelineId="p" stages={[stage]} defaultContactId="k" onSaved={onSaved} onCancel={vi.fn()} />)
    fireEvent.change(await screen.findByPlaceholderText("Deal title"), { target: { value: "Novo" } })
    fireEvent.change(await screen.findByLabelText("Custo"), { target: { value: "1.200" } })
    fireEvent.click(screen.getByRole("button", { name: /Create deal/ }))
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    const id = h.inserts[0].id as string
    expect(id).toMatch(/^[0-9a-f-]{36}$/)
    expect(setDealFieldValue).toHaveBeenCalledWith(expect.anything(), "acc-1", id, "f1", 1200)
  })

  it("a new deal with no field values is inserted exactly as before (no id)", async () => {
    const onSaved = vi.fn()
    render(<DealFormBody pipelineId="p" stages={[stage]} defaultContactId="k" onSaved={onSaved} onCancel={vi.fn()} />)
    fireEvent.change(await screen.findByPlaceholderText("Deal title"), { target: { value: "Novo" } })
    await screen.findByLabelText("Custo")
    fireEvent.click(screen.getByRole("button", { name: /Create deal/ }))
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    expect("id" in h.inserts[0]).toBe(false)
    expect(setDealFieldValue).not.toHaveBeenCalled()
  })

  it("shows nothing and reads nothing without the pipelines module", async () => {
    h.pipelines = false
    render(<DealFormBody deal={deal} pipelineId="p" stages={[stage]} onSaved={vi.fn()} onCancel={vi.fn()} />)
    await screen.findByDisplayValue("Contrato")
    expect(screen.queryByLabelText("Custo")).toBeNull()
    expect(listDealFields).not.toHaveBeenCalled()
  })

  it("tells the user when the deal saved but a value did not", async () => {
    vi.mocked(setDealFieldValue).mockRejectedValue({ code: "42501" })
    const { custo, onSaved } = await editForm()
    fireEvent.change(custo, { target: { value: "7" } })
    fireEvent.click(screen.getByRole("button", { name: /Save/ }))
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    expect(toast.error).toHaveBeenCalledWith("The deal was saved, but some field values were not")
  })
})

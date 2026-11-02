// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { toast } from "sonner"

import type { DealItem, Product } from "@/lib/products/types"

const h = vi.hoisted(() => ({ canEdit: true }))

vi.mock("@/hooks/use-language", () => ({
  useLanguage: () => ({ language: "pt-BR", t: (s: string) => s }),
}))
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ accountId: "acc-1" }) }))
vi.mock("@/hooks/use-can", () => ({ useCan: () => h.canEdit }))
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }))
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock("@/lib/products/data", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/products/data")>()),
  listDealItems: vi.fn(),
  listProducts: vi.fn(),
  addDealItem: vi.fn(),
  updateDealItem: vi.fn(),
  removeDealItem: vi.fn(),
}))

import { addDealItem, listDealItems, listProducts, removeDealItem, updateDealItem } from "@/lib/products/data"
import { DealItemsSection } from "./deal-items"

const item = (over: Partial<DealItem> = {}): DealItem => ({
  id: "i1",
  account_id: "acc-1",
  deal_id: "d1",
  product_id: null,
  name: "Plano Mensal",
  unit_price: 100,
  quantity: 2,
  discount_pct: 0,
  position: 0,
  line_total: 200,
  ...over,
})
const product = (over: Partial<Product> = {}): Product => ({
  id: "p1",
  account_id: "acc-1",
  name: "Instalação",
  code: "INS",
  unit_price: 300,
  description: null,
  archived_at: null,
  ...over,
})

function setup(items: DealItem[]) {
  vi.mocked(listDealItems).mockResolvedValue(items)
  vi.mocked(listProducts).mockResolvedValue([product()])
  const onChanged = vi.fn()
  const onCount = vi.fn()
  render(<DealItemsSection dealId="d1" currency="BRL" onChanged={onChanged} onCount={onCount} />)
  return { onChanged, onCount }
}

beforeEach(() => {
  h.canEdit = true
  vi.mocked(addDealItem).mockResolvedValue(undefined)
  vi.mocked(updateDealItem).mockResolvedValue(undefined)
  vi.mocked(removeDealItem).mockResolvedValue(undefined)
})
afterEach(cleanup)

describe("DealItemsSection", () => {
  it("lists the lines with the total and tells the parent how many there are", async () => {
    const { onCount } = setup([item(), item({ id: "i2", name: "Instalação", unit_price: 50, quantity: 1, discount_pct: 10, line_total: 45 })])
    expect(await screen.findByText("Plano Mensal")).toBeTruthy()
    expect(screen.getByText("Instalação")).toBeTruthy()
    expect(screen.getByText(/R\$\s245,00/)).toBeTruthy() // total of the items
    expect(screen.getByText(/2 × R\$\s100,00/)).toBeTruthy()
    expect(screen.getByText(/− 10%/)).toBeTruthy()
    expect(onCount).toHaveBeenCalledWith(2)
  })

  it("shows the empty state, and hides every edit control from someone who cannot edit the deal", async () => {
    h.canEdit = false
    setup([])
    expect(await screen.findByText("No products or services in this deal.")).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Add item" })).toBeNull()
  })

  it("a viewer sees the lines but no edit or remove buttons", async () => {
    h.canEdit = false
    setup([item()])
    await screen.findByText("Plano Mensal")
    expect(screen.queryByRole("button", { name: /Edit item/ })).toBeNull()
    expect(screen.queryByRole("button", { name: /Remove item/ })).toBeNull()
  })

  it("adds a free-text line typed in pt-BR formats, then refreshes the deal", async () => {
    const { onChanged } = setup([])
    fireEvent.click(await screen.findByRole("button", { name: "Add item" }))
    fireEvent.change(screen.getByLabelText("Product or service name"), { target: { value: "Consultoria" } })
    fireEvent.change(screen.getByLabelText("Price per unit"), { target: { value: "R$ 1.500,00" } })
    fireEvent.change(screen.getByLabelText("Number of units"), { target: { value: "1,5" } })
    fireEvent.change(screen.getByLabelText("Discount in percent"), { target: { value: "10" } })
    expect(screen.getByText("Line total")).toBeTruthy()
    expect(screen.getByText(/^R\$\s2\.025,00$/)).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Add item" }))
    await waitFor(() => expect(addDealItem).toHaveBeenCalled())
    expect(addDealItem).toHaveBeenCalledWith(
      expect.anything(),
      "acc-1",
      "d1",
      { name: "Consultoria", unit_price: 1500, quantity: 1.5, discount_pct: 10 },
      { productId: null, position: 0 },
    )
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1))
    expect(toast.success).toHaveBeenCalledWith("Item added")
  })

  it("picks from the catalog: copies name and price and links the product", async () => {
    setup([])
    fireEvent.click(await screen.findByRole("button", { name: "Add item" }))
    const matches = await screen.findByRole("list", { name: "Catalog matches" })
    fireEvent.click(within(matches).getByRole("button", { name: /Instalação/ }))
    expect((screen.getByLabelText("Product or service name") as HTMLInputElement).value).toBe("Instalação")
    expect((screen.getByLabelText("Price per unit") as HTMLInputElement).value).toBe("300")
    fireEvent.click(screen.getByRole("button", { name: "Add item" }))
    await waitFor(() => expect(addDealItem).toHaveBeenCalled())
    expect(vi.mocked(addDealItem).mock.calls[0][4]).toEqual({ productId: "p1", position: 0 })
    expect(vi.mocked(addDealItem).mock.calls[0][3]).toMatchObject({ name: "Instalação", unit_price: 300, quantity: 1 })
  })

  it("editing the name after picking turns it back into a free-text line", async () => {
    setup([])
    fireEvent.click(await screen.findByRole("button", { name: "Add item" }))
    const matches = await screen.findByRole("list", { name: "Catalog matches" })
    fireEvent.click(within(matches).getByRole("button", { name: /Instalação/ }))
    fireEvent.change(screen.getByLabelText("Product or service name"), { target: { value: "Instalação especial" } })
    fireEvent.click(screen.getByRole("button", { name: "Add item" }))
    await waitFor(() => expect(addDealItem).toHaveBeenCalled())
    expect(vi.mocked(addDealItem).mock.calls[0][4]).toMatchObject({ productId: null })
  })

  it("shows accessible errors and sends nothing when the fields are wrong", async () => {
    setup([])
    fireEvent.click(await screen.findByRole("button", { name: "Add item" }))
    fireEvent.change(screen.getByLabelText("Number of units"), { target: { value: "0" } })
    fireEvent.change(screen.getByLabelText("Discount in percent"), { target: { value: "150" } })
    fireEvent.click(screen.getByRole("button", { name: "Add item" }))
    const name = screen.getByLabelText("Product or service name")
    expect(name.getAttribute("aria-invalid")).toBe("true")
    expect(screen.getByLabelText("Number of units").getAttribute("aria-invalid")).toBe("true")
    expect(screen.getAllByRole("alert").map((a) => a.textContent)).toEqual([
      "Type the name of the product or service",
      "Type a number of units above zero, like 2 or 1,5",
      "Type a discount from 0 to 100",
    ])
    expect(name.getAttribute("aria-describedby")).toBe(screen.getAllByRole("alert")[0].id)
    expect(addDealItem).not.toHaveBeenCalled()
  })

  it("keeps the form open and shows the database message when the write fails", async () => {
    vi.mocked(addDealItem).mockRejectedValue({ code: "22003", message: "deal_items_total_too_large" })
    const { onChanged } = setup([])
    fireEvent.click(await screen.findByRole("button", { name: "Add item" }))
    fireEvent.change(screen.getByLabelText("Product or service name"), { target: { value: "Grande" } })
    fireEvent.change(screen.getByLabelText("Price per unit"), { target: { value: "10" } })
    fireEvent.click(screen.getByRole("button", { name: "Add item" }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("The items add up to more than the deal value limit"))
    expect(screen.getByLabelText("Product or service name")).toBeTruthy()
    expect(onChanged).not.toHaveBeenCalled()
  })

  it("shows the decimal hint, and the busy state resets even when the refresh fails", async () => {
    const { onChanged } = setup([item()])
    onChanged.mockRejectedValue(new Error("refetch failed"))
    fireEvent.click(await screen.findByRole("button", { name: "Add item" }))
    expect(screen.getByText("Use a comma for decimals, like 1,5")).toBeTruthy()
    fireEvent.change(screen.getByLabelText("Product or service name"), { target: { value: "X" } })
    fireEvent.click(screen.getByRole("button", { name: "Add item" }))
    await waitFor(() => expect(onChanged).toHaveBeenCalled())
    await waitFor(() => expect((screen.getByRole("button", { name: "Add item" }) as HTMLButtonElement).disabled).toBe(false))
    expect(toast.success).toHaveBeenCalledWith("Item added")
  })

  it("removes a line and refreshes the deal", async () => {
    const { onChanged } = setup([item()])
    // Removing is inside the line's editor, one step away from a stray click.
    expect(screen.queryByRole("button", { name: /Remove item/ })).toBeNull()
    fireEvent.click(await screen.findByRole("button", { name: /Edit item:\s*Plano Mensal/ }))
    fireEvent.click(screen.getByRole("button", { name: "Remove item: Plano Mensal" }))
    await waitFor(() => expect(removeDealItem).toHaveBeenCalledWith(expect.anything(), "i1"))
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1))
    expect(toast.success).toHaveBeenCalledWith("Item removed")
    await waitFor(() => expect(screen.queryByLabelText("Number of units")).toBeNull())
  })

  it("edits a line in place", async () => {
    setup([item()])
    fireEvent.click(await screen.findByRole("button", { name: /Edit item:\s*Plano Mensal/ }))
    fireEvent.click(screen.getByRole("button", { name: "One unit more" })) // 2 → 3
    fireEvent.click(screen.getByRole("button", { name: "Save item" }))
    await waitFor(() => expect(updateDealItem).toHaveBeenCalled())
    expect(updateDealItem).toHaveBeenCalledWith(expect.anything(), "i1", { name: "Plano Mensal", unit_price: 100, quantity: 3, discount_pct: 0 })
  })

  it("the unit stepper never goes below one and keeps decimals", async () => {
    setup([])
    fireEvent.click(await screen.findByRole("button", { name: "Add item" }))
    const units = screen.getByLabelText("Number of units") as HTMLInputElement
    const less = screen.getByRole("button", { name: "One unit less" }) as HTMLButtonElement
    expect(less.disabled).toBe(true) // starts at 1
    fireEvent.change(units, { target: { value: "1,5" } })
    fireEvent.click(screen.getByRole("button", { name: "One unit more" }))
    expect(units.value).toBe("2,5")
    fireEvent.click(less)
    fireEvent.click(less)
    expect(units.value).toBe("1")
  })

  it("offers a retry when the lines cannot be loaded", async () => {
    vi.mocked(listDealItems).mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce([item()])
    vi.mocked(listProducts).mockResolvedValue([])
    render(<DealItemsSection dealId="d1" currency="BRL" onChanged={vi.fn()} />)
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }))
    expect(await screen.findByText("Plano Mensal")).toBeTruthy()
  })
})

import { describe, expect, it } from "vitest"
import { renderToString } from "react-dom/server"

import {
  availableSuggestions,
  buildApplyBody,
  DealSummaryResult,
  type DealSummaryData,
  type SuggestionKey,
} from "./deal-summary-card"

const data: DealSummaryData = {
  summary: { wants: "Plano anual", status: "Comparando preço", next_step: "Enviar proposta" },
  deal: { id: "deal-1", title: "Plano anual", value: 1000, currency: "BRL", expected_close_date: null, stage_id: "s-new", stage_name: "Novo" },
  stages: [
    { id: "s-new", name: "Novo" },
    { id: "s-prop", name: "Proposta" },
  ],
  updates: {
    stage_id: "s-prop",
    value: 2400,
    expected_close_date: "2026-11-20",
    task: { title: "Enviar proposta", due_date: "2026-11-02" },
    note: "O que o cliente quer: Plano anual",
  },
}
const all = new Set<SuggestionKey>(["stage", "value", "date", "task", "note"])
const noop = () => {}

describe("availableSuggestions", () => {
  it("lists every proposal that exists", () => {
    expect(availableSuggestions(data)).toEqual(["stage", "value", "date", "task", "note"])
  })
  it("only the note when the model proposed nothing else", () => {
    const d = { ...data, updates: { stage_id: null, value: null, expected_close_date: null, task: null, note: "x" } }
    expect(availableSuggestions(d)).toEqual(["note"])
  })
  it("nothing without an open deal", () => {
    expect(availableSuggestions({ ...data, deal: null, updates: null })).toEqual([])
  })
})

describe("buildApplyBody", () => {
  it("sends only what is checked", () => {
    expect(buildApplyBody(data, new Set<SuggestionKey>(["value"]))).toEqual({ deal_id: "deal-1", value: 2400 })
    expect(buildApplyBody(data, new Set<SuggestionKey>(["stage", "task"]))).toEqual({
      deal_id: "deal-1",
      stage_id: "s-prop",
      task: { title: "Enviar proposta", due_date: "2026-11-02" },
    })
  })
  it("sends everything when all are checked", () => {
    expect(Object.keys(buildApplyBody(data, all)!).sort()).toEqual(
      ["deal_id", "expected_close_date", "note", "stage_id", "task", "value"],
    )
  })
  it("is null when nothing is checked or there is no deal", () => {
    expect(buildApplyBody(data, new Set())).toBeNull()
    expect(buildApplyBody({ ...data, deal: null, updates: null }, all)).toBeNull()
  })
})

describe("DealSummaryResult", () => {
  const render = (over: Partial<Parameters<typeof DealSummaryResult>[0]> = {}) =>
    renderToString(
      <DealSummaryResult data={data} checked={all} onToggle={noop} onApply={noop} onClose={noop} applying={false} results={null} {...over} />,
    )

  it("shows the three summary parts and current → proposed with pre-checked boxes", () => {
    const html = render()
    expect(html).toContain("Plano anual")
    expect(html).toContain("Comparando preço")
    expect(html).toContain("Enviar proposta")
    expect(html).toContain("Novo → Proposta")
    expect(html).toContain("→")
    expect(html).toContain("20/11/2026")
    expect(html.match(/type="checkbox"/g)).toHaveLength(5)
    expect(html.match(/checked=""/g)).toHaveLength(5)
    expect(html).toContain("Nada muda até você clicar em Aplicar")
    expect(html).toContain(">Aplicar<")
  })

  it("an unchecked box renders unchecked and Aplicar is disabled with nothing checked", () => {
    const html = render({ checked: new Set<SuggestionKey>() })
    expect(html).not.toContain('checked=""')
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>[^<]*Aplicar/)
  })

  it("without an open deal shows only the summary and says why", () => {
    const html = render({ data: { ...data, deal: null, updates: null } })
    expect(html).toContain("Este contato não tem negócio aberto")
    expect(html).not.toContain('type="checkbox"')
    expect(html).not.toContain(">Aplicar<")
  })

  it("after applying, shows a status per item and hides the Aplicar button", () => {
    const html = render({ results: { stageId: "applied", value: "failed", note: "too_long" } })
    expect(html).toContain("Aplicado no negócio")
    expect(html).toContain("Não foi possível aplicar")
    expect(html).toContain("Não cabe nas notas do negócio")
    expect(html).not.toContain(">Aplicar<")
    expect(html).toContain('disabled=""')
  })
})

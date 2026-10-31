import { describe, expect, it } from "vitest"
import { renderToString } from "react-dom/server"

import {
  availableSuggestions,
  buildApplyBody,
  defaultChecked,
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
    origin: { stage_id: "atendente", value: "cliente", expected_close_date: "atendente" },
  },
}
const all = new Set<SuggestionKey>(["stage", "value", "date", "task", "note"])
const noop = () => {}

describe("availableSuggestions / defaultChecked", () => {
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
  it("pre-checks ONLY the note and the task: stage, value and date start unchecked", () => {
    expect([...defaultChecked(data)].sort()).toEqual(["note", "task"])
    expect(defaultChecked({ ...data, updates: { ...data.updates!, task: null } })).toEqual(new Set(["note"]))
  })
})

describe("buildApplyBody", () => {
  const expected = { stage_id: "s-new", value: 1000, expected_close_date: null }

  it("sends only what is checked, plus what the card showed", () => {
    expect(buildApplyBody(data, new Set<SuggestionKey>(["value"]))).toEqual({ deal_id: "deal-1", expected, value: 2400 })
    expect(buildApplyBody(data, new Set<SuggestionKey>(["stage", "task"]))).toEqual({
      deal_id: "deal-1",
      expected,
      stage_id: "s-prop",
      task: { title: "Enviar proposta", due_date: "2026-11-02" },
    })
  })
  it("sends everything when all are checked", () => {
    expect(Object.keys(buildApplyBody(data, all)!).sort()).toEqual(
      ["deal_id", "expected", "expected_close_date", "note", "stage_id", "task", "value"],
    )
  })
  it("the default selection sends just the note and the task", () => {
    expect(Object.keys(buildApplyBody(data, defaultChecked(data))!).sort()).toEqual(["deal_id", "expected", "note", "task"])
  })
  it("is null when nothing is checked or there is no deal", () => {
    expect(buildApplyBody(data, new Set())).toBeNull()
    expect(buildApplyBody({ ...data, deal: null, updates: null }, all)).toBeNull()
  })
})

describe("DealSummaryResult", () => {
  const render = (over: Partial<Parameters<typeof DealSummaryResult>[0]> = {}) =>
    renderToString(
      <DealSummaryResult data={data} checked={defaultChecked(data)} onToggle={noop} onApply={noop} onClose={noop} applying={false} results={null} {...over} />,
    )

  it("shows the summary, current → proposed, who said it, and only note + task pre-checked", () => {
    const html = render()
    expect(html).toContain("Comparando preço")
    expect(html).toContain("Novo → Proposta")
    expect(html).toContain("20/11/2026")
    expect(html.match(/type="checkbox"/g)).toHaveLength(5)
    expect(html.match(/checked=""/g)).toHaveLength(2)
    expect(html).toContain("dito pelo atendente")
    expect(html).toContain("dito pelo cliente")
    expect(html).toContain("Nada muda até você clicar em Aplicar")
    expect(html).toContain(">Aplicar<")
  })

  it("a proposal without origin is shown as said by the customer", () => {
    const d = { ...data, updates: { ...data.updates!, origin: undefined } }
    const html = render({ data: d })
    expect(html).not.toContain("dito pelo atendente")
    expect(html).toContain("dito pelo cliente")
  })

  it("Aplicar is disabled with nothing checked", () => {
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
  })

  it("stale, already and duplicate have their own messages", () => {
    const html = render({ results: { stageId: "already", value: "stale", task: "duplicate" } })
    expect(html).toContain("Já está nessa etapa")
    expect(html).toContain("O negócio mudou desde o resumo — resuma de novo")
    expect(html).toContain("Já existe uma tarefa aberta com esse título")
  })

  it("a deal closed since the summary locks every checkbox and hides Aplicar", () => {
    const html = render({ closed: true })
    expect(html).toContain("Este negócio não está mais aberto")
    expect(html.match(/disabled=""/g)).toHaveLength(5)
    expect(html).not.toContain(">Aplicar<")
  })
})

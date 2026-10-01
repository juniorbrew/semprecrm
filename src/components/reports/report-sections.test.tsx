import { describe, expect, it } from "vitest"
import { renderToString } from "react-dom/server"

import { reportsCopy, type BacklogRow, type ReportRow } from "@/lib/support/reports"
import { BacklogSection, GroupSection, OverviewSection, PrioritySection } from "./report-sections"

const copy = reportsCopy("pt-BR")
const row = (over: Partial<ReportRow> = {}): ReportRow => ({
  group_key: "k",
  opened: 10,
  resolved: 8,
  backlog: 2,
  fr_count: 5,
  fr_avg_seconds: 160,
  fr_median_seconds: 120,
  fr_p90_seconds: 264,
  res_count: 8,
  res_avg_seconds: 7500,
  res_median_seconds: 3600,
  res_p90_seconds: 20000,
  sla_met: 6,
  sla_missed: 2,
  reopened: 1,
  csat_sent: 4,
  csat_answered: 3,
  csat_avg: 4.33,
  ...over,
})

describe("OverviewSection", () => {
  it("lists every number with its median and p90, in pt-BR", () => {
    const html = renderToString(<OverviewSection row={row({ group_key: "all" })} copy={copy} language="pt-BR" />)
    expect(html).toContain('data-testid="reports-overview"')
    for (const label of ["Abertas", "Resolvidas", "Em aberto agora", "Primeira resposta", "Resolução", "Prazos cumpridos", "Reabertas", "Satisfação"]) {
      expect(html).toContain(label)
    }
    expect(html).toContain("2 min") // first response average 160 s
    expect(html).toContain("mediana 2 min · p90 4 min")
    expect(html).toContain("2 h 5 min") // resolution average
    expect(html).toContain("75%") // SLA 6 of 8
    expect(html).toContain("10%") // reopened 1 of 10
    expect(html).toContain("4,3") // CSAT average
    expect(html).toContain("3 de 4") // answered of sent
  })

  it("no rows or all zeros is one sentence, no tables", () => {
    for (const r of [undefined, row({ opened: 0, resolved: 0, backlog: 0, csat_sent: 0 })]) {
      const html = renderToString(<OverviewSection row={r} copy={copy} language="pt-BR" />)
      expect(html).toContain('data-testid="reports-empty"')
      expect(html).toContain("Nenhuma conversa no período.")
      expect(html).not.toContain("<dl")
    }
  })

  it("a metric without data reads as a dash, never NaN or null", () => {
    const html = renderToString(
      <OverviewSection
        row={row({ fr_avg_seconds: null, fr_median_seconds: null, fr_p90_seconds: null, sla_met: 0, sla_missed: 0, csat_sent: 0, csat_answered: 0, csat_avg: null, reopened: 0 })}
        copy={copy}
        language="pt-BR"
      />,
    )
    expect(html).toContain("—")
    expect(html).not.toMatch(/NaN|null|undefined/)
  })
})

describe("GroupSection", () => {
  const rows = [row({ group_key: "a", opened: 10 }), row({ group_key: null, opened: 5, csat_avg: null, fr_avg_seconds: null })]
  const labelFor = (k: string | null) => (k === "a" ? "Cobrança" : copy.none)

  it("a row per group with a bar sized to the largest volume", () => {
    const html = renderToString(<GroupSection title="Por categoria" rows={rows} labelFor={labelFor} copy={copy} language="pt-BR" testId="reports-category" />)
    expect(html).toContain("Por categoria")
    expect(html).toContain('data-testid="reports-category"')
    expect(html).toContain("Cobrança")
    expect(html).toContain("Sem definição")
    expect(html).toContain("width:100%")
    expect(html).toContain("width:50%")
    // accessible table: headers are columnheaders, groups are row headers
    expect(html).toContain('scope="col"')
    expect(html).toContain('scope="row"')
  })

  it("nothing to show hides the whole section", () => {
    const html = renderToString(
      <GroupSection title="Por equipe" rows={[row({ opened: 0, resolved: 0, backlog: 0, csat_sent: 0 })]} labelFor={labelFor} copy={copy} language="pt-BR" testId="reports-team" />,
    )
    expect(html).toBe("")
  })

  it("follows the design rules: no all-caps labels, no gradients, no emoji", () => {
    const html = renderToString(<GroupSection title="Por equipe" rows={rows} labelFor={labelFor} copy={copy} language="pt-BR" testId="t" />)
    expect(html).not.toMatch(/uppercase|gradient|tracking-widest/)
  })
})

describe("PrioritySection", () => {
  it("urgent first, with how many deadlines were kept", () => {
    const html = renderToString(
      <PrioritySection
        copy={copy}
        rows={[row({ group_key: "low", opened: 1, sla_met: 0, sla_missed: 0 }), row({ group_key: "urgent", opened: 4, sla_met: 3, sla_missed: 1 })]}
      />,
    )
    expect(html.indexOf("Urgente")).toBeGreaterThan(-1)
    expect(html.indexOf("Urgente")).toBeLessThan(html.indexOf("Baixa"))
    expect(html).toContain("75%")
  })
})

describe("BacklogSection", () => {
  const rows: BacklogRow[] = [
    { bucket: "lt1d", total: 5 },
    { bucket: "d1_3", total: 2 },
    { bucket: "d3_7", total: 0 },
    { bucket: "gt7", total: 1 },
  ]
  it("four buckets in order of age", () => {
    const html = renderToString(<BacklogSection rows={rows} copy={copy} />)
    const order = ["Menos de 1 dia", "1 a 3 dias", "3 a 7 dias", "Mais de 7 dias"].map((l) => html.indexOf(l))
    expect(order.every((i) => i >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
  })
  it("an empty queue renders nothing", () => {
    expect(renderToString(<BacklogSection rows={rows.map((r) => ({ ...r, total: 0 }))} copy={copy} />)).toBe("")
  })
})

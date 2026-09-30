import { afterEach, describe, expect, it, vi } from "vitest"
import { renderToString } from "react-dom/server"

import type { Contact, Deal, Tag } from "@/types"
import { PanelActivity } from "./panel-activity"
import { PANEL_DEAL_LIMIT, PanelDeals } from "./panel-deals"
import { PanelSection, SectionHeader, readSectionOpen } from "./panel-section"
import { PanelTags } from "./panel-tags"
import { ContactSidebar } from "./contact-sidebar"
import { Building2 } from "lucide-react"

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => {
    throw new Error("createClient must only be called from effects/handlers")
  },
}))

afterEach(() => vi.unstubAllGlobals())

const deal = (n: number): Deal =>
  ({
    id: `d${n}`,
    user_id: "u",
    pipeline_id: "p1",
    stage_id: "s1",
    contact_id: "c1",
    title: `Negocio ${n}`,
    value: 100 * n,
    created_at: "2026-09-01T00:00:00Z",
    stage: { id: "s1", pipeline_id: "p1", name: "Novo", position: 0, color: "#3b82f6", created_at: "" },
  }) as Deal

describe("PanelSection", () => {
  const section = (id: string, defaultOpen?: boolean) =>
    renderToString(
      <PanelSection id={id} defaultOpen={defaultOpen}>
        <div>
          <SectionHeader icon={Building2} label="Empresas" count={2} />
          <p>corpo</p>
        </div>
      </PanelSection>,
    )

  it("renders open by default with an expandable header", () => {
    const html = section("x")
    expect(html).toContain('aria-expanded="true"')
    expect(html).toContain('data-collapsed="false"')
  })

  it("honours defaultOpen=false and a remembered state from localStorage", () => {
    expect(section("x", false)).toContain('data-collapsed="true"')
    vi.stubGlobal("window", { localStorage: { getItem: () => JSON.stringify({ x: false }) } })
    expect(readSectionOpen("x", true)).toBe(false)
    expect(readSectionOpen("other", true)).toBe(true)
  })

  it("lazy sections render only their header until first opened (children never mount, so no queries)", () => {
    const lazy = (defaultOpen: boolean) =>
      renderToString(
        <PanelSection id="lz" defaultOpen={defaultOpen} lazyHeader={<SectionHeader icon={Building2} label="Atividade" />}>
          <div>
            <SectionHeader icon={Building2} label="Atividade" />
            <p>corpo-carregado</p>
          </div>
        </PanelSection>,
      )
    expect(lazy(false)).not.toContain("corpo-carregado")
    expect(lazy(false)).toContain("Atividade")
    expect(lazy(true)).toContain("corpo-carregado")
  })

  it("survives blocked or corrupt storage", () => {
    vi.stubGlobal("window", {
      localStorage: {
        getItem: () => {
          throw new Error("blocked")
        },
      },
    })
    expect(readSectionOpen("x", true)).toBe(true)
    vi.stubGlobal("window", { localStorage: { getItem: () => "{not json" } })
    expect(readSectionOpen("x", false)).toBe(false)
  })
})

describe("PanelDeals", () => {
  const base = { onPatch: () => {}, canWrite: true, conversationId: "conv-1" }

  it("shows a skeleton until loaded", () => {
    const html = renderToString(<PanelDeals {...base} deals={[]} loaded={false} />)
    expect(html).toContain('role="status"')
    expect(html).not.toContain("Nenhum negócio vinculado")
  })

  it("lists the latest 3 deals collapsed with a Ver todos toggle", () => {
    const deals = [1, 2, 3, 4, 5].map(deal)
    const html = renderToString(<PanelDeals {...base} deals={deals} loaded />)
    expect(PANEL_DEAL_LIMIT).toBe(3)
    expect(html).toContain("Negocio 3")
    expect(html).not.toContain("Negocio 4")
    expect(html).toContain("Ver todos (5)")
    // fields collapsed by default
    expect(html).toContain(">Campos do negócio<")
    expect(html).not.toContain("Previsão de fechamento")
  })

  it("renders the stage as a read-only chip until the stages load (and for viewers)", () => {
    const html = renderToString(<PanelDeals {...base} canWrite={false} deals={[deal(1)]} loaded />)
    expect(html).not.toContain("<select")
    expect(html).toContain("Novo")
  })

  it("shows the empty state", () => {
    expect(renderToString(<PanelDeals {...base} deals={[]} loaded />)).toContain("Nenhum negócio vinculado")
  })
})

describe("PanelTags", () => {
  const tag = (id: string, name: string) => ({ id, name, color: "#3b82f6" }) as Tag
  const props = {
    contactTags: [{ ...tag("a", "VIP"), contact_tag_id: "ct1" }],
    allTags: [tag("a", "VIP"), tag("b", "Lead"), tag("c", "Cliente")],
    usage: { b: 3, c: 9 },
    loaded: true,
    canCreate: true,
    creating: false,
    busyId: null,
    onToggle: () => {},
    onCreate: () => {},
  }

  it("offers the most-used unapplied tags as one-click chips, most used first", () => {
    const html = renderToString(<PanelTags {...props} canWrite />)
    expect(html).toContain('aria-label="Adicionar etiqueta Cliente"')
    expect(html.indexOf("Adicionar etiqueta Cliente")).toBeLessThan(html.indexOf("Adicionar etiqueta Lead"))
    expect(html).not.toContain('aria-label="Adicionar etiqueta VIP"')
    expect(html).toContain('aria-label="Remover etiqueta VIP"')
  })

  it("is read-only for viewers: no suggestions, no add button, chip disabled", () => {
    const html = renderToString(<PanelTags {...props} canWrite={false} />)
    expect(html).not.toContain("Mais usadas")
    expect(html).not.toContain('aria-label="Adicionar etiqueta"')
    expect(html).toMatch(/<button[^>]*disabled[^>]*aria-label="Remover etiqueta VIP"|aria-label="Remover etiqueta VIP"[^>]*disabled/)
  })
})

describe("PanelActivity", () => {
  it("renders the Atividade header with a skeleton while loading", () => {
    const html = renderToString(<PanelActivity contactId="c1" />)
    expect(html).toContain("Atividade")
    expect(html).toContain('role="status"')
  })
})

describe("ContactSidebar — panel order and skeleton", () => {
  const contact: Contact = {
    id: "c-1",
    user_id: "u-1",
    account_id: "a-1",
    phone: "5511988887777",
    name: "Maria Souza",
    created_at: "2026-09-27T00:00:00Z",
    updated_at: "2026-09-27T00:00:00Z",
  }

  it("orders Empresas, Negócios, Atividade, Notas, Privacidade and shows skeletons before the data arrives", () => {
    const html = renderToString(<ContactSidebar contact={contact} conversationId="conv-1" />)
    const at = (label: string) => html.indexOf(`>${label}<`)
    const order = ["Empresas", "Negócios vinculados", "Atividade", "Notas internas", "Privacidade"].map(at)
    expect(order.every((i) => i > 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    expect(html).toContain('aria-label="Carregando negócios"')
    expect(html).toContain('aria-label="Carregando etiquetas"')
  })
})

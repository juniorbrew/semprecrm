import { describe, expect, it, vi } from "vitest"
import { renderToString } from "react-dom/server"

vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }))
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ accountId: "a-1", user: null, preferences: {} }) }))

import type { ConversationCategory } from "@/lib/support/model"
import type { Conversation } from "@/types"
import { SubjectLine, TriageChips } from "./triage-chips"
import { ConversationItem, type ConversationItemProps } from "./conversation-list"

const cat: ConversationCategory = {
  id: "c1",
  account_id: "a-1",
  name: "Cobrança",
  description: null,
  color: "amber",
  default_priority: "high",
  position: 0,
  archived_at: null,
}
const byId = new Map([[cat.id, cat]])
const noop = () => {}

describe("TriageChips", () => {
  it("agents get two editable chips: category name and priority", () => {
    const html = renderToString(
      <TriageChips conversation={{ category_id: "c1", priority: "urgent", sentiment: null }} categories={[cat]} byId={byId} canEdit onCategory={noop} onPriority={noop} />,
    )
    expect(html).toContain("Cobrança")
    expect(html).toContain("Urgente")
    expect(html.match(/<button/g)).toHaveLength(2)
    expect(html).toContain('aria-label="Categoria"')
    expect(html).toContain('aria-label="Prioridade"')
    // text-first: a coloured dot, no emoji, no all-caps utility.
    expect(html).toContain("bg-amber-500")
    expect(html).toContain("bg-red-500")
    expect(html).not.toContain("uppercase")
  })

  it("agents see a placeholder when nothing is set", () => {
    const html = renderToString(
      <TriageChips conversation={{ category_id: null, priority: "normal", sentiment: null }} categories={[cat]} byId={byId} canEdit onCategory={noop} onPriority={noop} />,
    )
    expect(html).toContain("Categoria")
    expect(html).toContain("Normal")
  })

  it("viewers read only: no buttons, and empty chips are hidden", () => {
    const set = renderToString(
      <TriageChips conversation={{ category_id: "c1", priority: "high", sentiment: null }} categories={[cat]} byId={byId} canEdit={false} onCategory={noop} onPriority={noop} />,
    )
    expect(set).toContain("Cobrança")
    expect(set).toContain("Alta")
    expect(set).not.toContain("<button")
    const empty = renderToString(
      <TriageChips conversation={{ category_id: null, priority: "normal", sentiment: null }} categories={[cat]} byId={byId} canEdit={false} onCategory={noop} onPriority={noop} />,
    )
    expect(empty).not.toContain("Normal")
    expect(empty).not.toContain("Categoria")
  })

  it("an archived category keeps its name on old conversations", () => {
    const archived = new Map([[cat.id, { ...cat, archived_at: "2026-01-01" }]])
    const html = renderToString(
      <TriageChips conversation={{ category_id: "c1", priority: "normal", sentiment: null }} categories={[]} byId={archived} canEdit={false} onCategory={noop} onPriority={noop} />,
    )
    expect(html).toContain("Cobrança")
  })
})

describe("SubjectLine", () => {
  it("shows the subject as one muted line; agents can click it, viewers cannot", () => {
    const agent = renderToString(<SubjectLine subject="Boleto não chegou" canEdit onSave={noop} />)
    expect(agent).toContain("Boleto não chegou")
    expect(agent).toContain("<button")
    expect(agent).toContain("truncate")
    const viewer = renderToString(<SubjectLine subject="Boleto não chegou" canEdit={false} onSave={noop} />)
    expect(viewer).toContain("Boleto não chegou")
    expect(viewer).not.toContain("<button")
  })

  it("an empty subject is an add affordance for agents and nothing for viewers", () => {
    expect(renderToString(<SubjectLine subject={null} canEdit onSave={noop} />)).toContain("Adicionar assunto")
    expect(renderToString(<SubjectLine subject={null} canEdit={false} onSave={noop} />)).toBe("")
  })
})

describe("ConversationItem (list row)", () => {
  const conv = (over: Partial<Conversation>): Conversation => ({
    id: "conv-1",
    user_id: "u",
    contact_id: "k",
    status: "open",
    unread_count: 0,
    created_at: "2026-09-30T10:00:00Z",
    updated_at: "2026-09-30T10:00:00Z",
    last_message_text: "oi",
    ...over,
  })
  const render = (c: Conversation, category: ConversationItemProps["category"] = null) =>
    renderToString(
      <ConversationItem
        conversation={c}
        isActive={false}
        isCursor={false}
        ownerName={null}
        ownerTitle={() => ""}
        onSelect={noop}
        age="1 min"
        tags={[]}
        companyName={null}
        category={category}
        priorityLabel="Urgente"
        rowStatus={{ pending: "Pendente", closed: "Resolvida", archived: "Arquivada" }}
        channelLabel="WhatsApp"
        channelChip={{ official: "Oficial", qr: "QR" }}
        moreTags={(n) => `+${n}`}
        waitingLabel={null}
        waitingTitle=""
        queue={null}
      />,
    )

  it("shows a priority dot only for urgent / high, and a muted category label", () => {
    expect(render(conv({ priority: "urgent" }))).toContain('data-testid="priority-dot"')
    expect(render(conv({ priority: "high" }))).toContain('data-testid="priority-dot"')
    expect(render(conv({ priority: "normal" }))).not.toContain("priority-dot")
    expect(render(conv({ priority: "low" }))).not.toContain("priority-dot")
    expect(render(conv({}))).not.toContain("priority-dot")
    const html = render(conv({ category_id: "c1" }), { name: "Cobrança", color: "amber" })
    expect(html).toContain('data-testid="category-label"')
    expect(html).toContain("Cobrança")
    expect(render(conv({}))).not.toContain("category-label")
  })
})

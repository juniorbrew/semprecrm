import { afterEach, describe, expect, it, vi } from "vitest"
import { renderToString } from "react-dom/server"

vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }))
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ accountId: "a-1", user: null, preferences: {} }) }))

import type { Conversation } from "@/types"
import { ConversationItem, readDensity, writeDensity, type ConversationItemProps } from "./conversation-list"

const quick: NonNullable<ConversationItemProps["quick"]> = {
  toolbar: (n) => `Ações rápidas: ${n}`,
  resolve: "Resolver",
  reopen: "Reabrir",
  claim: "Assumir",
  resolveAria: (n) => `Resolver conversa com ${n}`,
  reopenAria: (n) => `Reabrir conversa com ${n}`,
  claimAria: (n) => `Assumir conversa com ${n}`,
  resolved: "",
  reopened: "",
  claimed: "",
  undo: "",
  failed: "",
  claimTaken: "",
  reopenBlocked: "",
  openCurrent: "",
}

const conv = (over: Partial<Conversation> = {}): Conversation => ({
  id: "c1",
  user_id: "u",
  contact_id: "k",
  status: "open",
  unread_count: 0,
  created_at: "2026-09-30T10:00:00Z",
  updated_at: "2026-09-30T10:00:00Z",
  last_message_text: "Quando chega o pedido?",
  contact: { id: "k", name: "Marina Souza", phone: "5511999990000" } as Conversation["contact"],
  ...over,
})

const render = (c: Conversation, extra: Partial<ConversationItemProps> = {}) =>
  renderToString(
    <ConversationItem
      conversation={c}
      isActive={false}
      isCursor={false}
      ownerName={null}
      ownerTitle={() => ""}
      onSelect={() => {}}
      age="5 min"
      tags={[]}
      companyName={null}
      category={{ name: "Entrega", color: "blue" }}
      priorityLabel="Normal"
      rowStatus={{ pending: "Pendente", closed: "Resolvida", archived: "Arquivada" }}
      channelLabel="WhatsApp"
      channelChip={{ official: "Oficial", qr: "QR" }}
      moreTags={(n) => `+${n}`}
      waitingLabel={null}
      waitingTitle=""
      queue={null}
      quick={quick}
      canClaim
      onQuickAction={async () => {}}
      {...extra}
    />,
  )

describe("ConversationItem row", () => {
  it("name, preview, time and one meta line with the category pill", () => {
    const html = render(conv())
    expect(html).toContain("Marina Souza")
    expect(html).toContain("Quando chega o pedido?")
    expect(html).toContain("5 min")
    expect(html.match(/data-testid="row-meta"/g)).toHaveLength(1)
    expect(html).toContain('data-testid="category-label"')
  })

  it("the unread counter is the only filled element", () => {
    const html = render(conv({ unread_count: 3 }))
    expect(html).toContain('data-testid="unread-count"')
    expect(html.match(/bg-primary text-primary-foreground|bg-primary px-1/g)).toHaveLength(1)
    expect(render(conv())).not.toContain("unread-count")
  })

  it("selected row: brand tint and a 3px accent", () => {
    const html = render(conv(), { isActive: true })
    expect(html).toContain("bg-primary/10")
    expect(html).toContain("before:w-[3px]")
    expect(html).toContain('aria-current="true"')
  })

  it("compact density hides the meta line", () => {
    const html = render(conv(), { compact: true })
    expect(html).not.toContain("row-meta")
    expect(html).toContain("py-1.5")
  })

  it("quick actions: labelled toolbar shown on hover and on focus-within, outside the row button", () => {
    const html = render(conv())
    expect(html).toContain('role="toolbar"')
    expect(html).toContain('aria-label="Ações rápidas: Marina Souza"')
    expect(html).toContain('aria-label="Resolver conversa com Marina Souza"')
    expect(html).toContain('aria-label="Assumir conversa com Marina Souza"')
    expect(html).toContain("group-hover/row:flex")
    expect(html).toContain("group-focus-within/row:flex")
    // No button nested inside the row button (invalid HTML, breaks clicks).
    const rowButton = html.slice(html.indexOf("<button"), html.indexOf("</button>"))
    expect(rowButton.match(/<button/g)).toHaveLength(1)
    expect(html).not.toMatch(/Adiar|snooze/i)
  })

  it("closed rows offer Reabrir and no Assumir; mine rows no Assumir; viewers nothing", () => {
    const closed = render(conv({ status: "closed" }))
    expect(closed).toContain('data-action="reopen"')
    expect(closed).not.toContain('data-action="claim"')
    expect(render(conv(), { canClaim: false })).not.toContain('data-action="claim"')
    expect(render(conv(), { quick: null })).not.toContain("row-quick-actions")
  })
})

describe("density preference", () => {
  const store = new Map<string, string>()
  const ls = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
  }
  afterEach(() => {
    store.clear()
    vi.unstubAllGlobals()
  })

  it("is per user and defaults to comfortable", () => {
    vi.stubGlobal("localStorage", ls)
    expect(readDensity("u1")).toBe("comfortable")
    writeDensity("u1", "compact")
    expect(readDensity("u1")).toBe("compact")
    expect(readDensity("u2")).toBe("comfortable")
    expect(store.get("wacrm:inbox:density:u1")).toBe("compact")
  })

  it("survives a throwing or missing localStorage", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked")
      },
      setItem: () => {
        throw new Error("blocked")
      },
    })
    expect(readDensity("u1")).toBe("comfortable")
    expect(() => writeDensity("u1", "compact")).not.toThrow()
  })
})

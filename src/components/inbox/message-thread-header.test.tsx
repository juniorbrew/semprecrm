import { describe, expect, it, vi } from "vitest"
import { renderToString } from "react-dom/server"

import type { Contact, Conversation } from "@/types"
import { MessageThread } from "./message-thread"

// A signed-in viewer: the header must still show Assumir / Transferir /
// Lembrar / Resolver, disabled, with the read-only hint.
const role = vi.hoisted(() => ({ current: "viewer" as "viewer" | "agent" }))
vi.mock("@/hooks/use-auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/hooks/use-auth")>()
  return {
    ...actual,
    useAuth: () => ({
      ...actual.useAuth(),
      user: { id: "viewer-1", email: "v@example.com" },
      accountRole: role.current,
    }),
  }
})
// The composer creates its client during render (useMemo); any actual
// call on it would mean I/O while rendering, so every method throws.
vi.mock("@/lib/supabase/client", () => ({
  createClient: () =>
    new Proxy(
      {},
      {
        get: (_t, key) => () => {
          throw new Error(`supabase.${String(key)} called during render`)
        },
      },
    ),
}))

const contact: Contact = {
  id: "c-1",
  user_id: "u-1",
  account_id: "a-1",
  phone: "5511988887777",
  name: "Maria Souza",
  created_at: "2026-09-27T00:00:00Z",
  updated_at: "2026-09-27T00:00:00Z",
}

const conversation: Conversation = {
  id: "conv-1",
  user_id: "u-1",
  contact_id: "c-1",
  status: "open",
  unread_count: 0,
  created_at: "2026-09-27T00:00:00Z",
  updated_at: "2026-09-27T00:00:00Z",
}

const noop = () => {}

function render(conv: Conversation) {
  return renderToString(
    <MessageThread
      conversation={conv}
      contact={contact}
      messages={[]}
      onMessagesLoaded={noop}
      onNewMessage={noop}
      onUpdateMessage={noop}
      onStatusChange={noop}
      onAssignChange={noop}
    />,
  )
}

/** The opening <button …> tag that carries `needle`. */
function buttonWith(html: string, needle: string): string {
  const at = html.indexOf(needle)
  if (at < 0) return ""
  const start = html.lastIndexOf("<button", at)
  return html.slice(start, html.indexOf(">", at) + 1)
}

describe("MessageThread header — viewer", () => {
  it("shows Assumir, Transferir, Resolver and Lembrar, all disabled", () => {
    const html = render(conversation)
    const readOnly = "Somente leitura — seu perfil não pode alterar conversas"
    // Assumir (unassigned open conversation) + Transferir + Resolver + status chevron.
    const tags = html.split(`title="${readOnly}"`).length - 1
    expect(tags).toBe(4)
    expect(html).toContain(">Assumir<")
    for (const part of html.split(`title="${readOnly}"`).slice(0, -1)) {
      const tag = part.slice(part.lastIndexOf("<button"))
      expect(tag).toContain('disabled=""')
    }
    // Lembrar is rendered (Tasks module assumed on) but not clickable.
    expect(buttonWith(html, 'title="Somente leitura — seu perfil não pode criar lembretes"')).toContain('disabled=""')
  })

  it("labels an archived conversation as Arquivada", () => {
    const html = render({ ...conversation, status: "closed", archived_at: "2026-09-27T10:00:00Z" })
    expect(html).toContain("Arquivada")
  })
})

describe("MessageThread header — agent", () => {
  it("localizes the Transferir tooltip (no English \"Assign\" inside)", () => {
    role.current = "agent"
    try {
      const html = render(conversation)
      expect(html).toContain('title="Responsável: sem responsável · Transferir"')
      expect(html).not.toContain("Responsável: Assign")
      expect(buttonWith(html, 'title="Assumir: atribuir esta conversa a você"')).not.toContain('disabled=""')
    } finally {
      role.current = "viewer"
    }
  })
})

describe("MessageThread header — Assumir when already mine", () => {
  it('shows a static "✓ Sua" instead of the Assumir button', () => {
    role.current = "agent"
    try {
      const html = render({ ...conversation, assigned_agent_id: "viewer-1" })
      expect(html).toContain('data-testid="claim-mine"')
      expect(html).toContain(">Sua<")
      expect(html).not.toContain(">Assumir<")
      // A plain <span>, not a (disabled) button.
      const at = html.indexOf('data-testid="claim-mine"')
      expect(html.slice(html.lastIndexOf("<", at), at)).toMatch(/^<span /)
      const openButtons = html.slice(0, at).split("<button").length - html.slice(0, at).split("</button>").length
      expect(openButtons).toBe(0)
    } finally {
      role.current = "viewer"
    }
  })

  it("keeps Assumir clickable on a teammate's conversation", () => {
    role.current = "agent"
    try {
      const html = render({ ...conversation, assigned_agent_id: "someone-else" })
      expect(html).not.toContain('data-testid="claim-mine"')
      expect(buttonWith(html, 'title="Assumir: atribuir esta conversa a você"')).not.toContain('disabled=""')
    } finally {
      role.current = "viewer"
    }
  })
})

describe("MessageThread header — one status line and the panel toggle", () => {
  it("puts SLA, state, channel and company on one line; the toggle is labelled and pressed", () => {
    const due = new Date(Date.now() + 40 * 60_000).toISOString()
    const html = renderToString(
      <MessageThread
        conversation={{ ...conversation, first_response_due_at: due }}
        contact={{ ...contact, company: "Casa Lima" }}
        messages={[]}
        onMessagesLoaded={noop}
        onNewMessage={noop}
        onUpdateMessage={noop}
        onStatusChange={noop}
        onAssignChange={noop}
        contactPanelOpen
        onToggleContactPanel={noop}
      />,
    )
    const at = html.indexOf('data-testid="thread-status-line"')
    const line = html.slice(at, html.indexOf("</div>", html.indexOf("Casa Lima", at)))
    expect(at).toBeGreaterThan(0)
    for (const part of ['data-testid="sla-line"', "Aberta", "Oficial", "Casa Lima"]) expect(line).toContain(part)
    expect(buttonWith(html, 'aria-label="Ocultar painel do contato"')).toContain('aria-pressed="true"')
  })
})

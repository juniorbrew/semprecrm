import { describe, expect, it, vi } from "vitest"
import { renderToString } from "react-dom/server"

import type { Contact } from "@/types"
import { ContactSidebar } from "./contact-sidebar"

// Rendered outside the auth provider: the role collapses to null, which
// is the least-privileged (viewer-like) state — every write control must
// render disabled. Effects never run, so Supabase is never touched.
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => {
    throw new Error("createClient must only be called from effects/handlers")
  },
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

describe("ContactSidebar — shortcuts and companies", () => {
  it("renders Marcar compromisso / Novo negócio / Ver contato and the Empresas section", () => {
    const html = renderToString(<ContactSidebar contact={contact} conversationId="conv-1" />)
    expect(html).toContain("Marcar compromisso")
    expect(html).toContain("Novo negócio")
    expect(html).toContain("Ver contato")
    expect(html).toContain('href="/contacts?contact=c-1"')
    expect(html).toContain(">Empresas<")
  })

  it("disables the write shortcuts without an agent+ role", () => {
    const html = renderToString(<ContactSidebar contact={contact} conversationId="conv-1" />)
    const tile = (label: string) => html.match(new RegExp(`<button[^>]*title="[^"]*"[^>]*>(?:(?!</button>).)*${label}`))?.[0] ?? ""
    expect(tile("Marcar compromisso")).toContain("disabled")
    expect(tile("Novo negócio")).toContain("disabled")
    expect(tile("Nova tarefa")).toContain("disabled")
    expect(html).toContain("Somente leitura — seu perfil não pode criar compromissos, negócios nem tarefas")
  })
})

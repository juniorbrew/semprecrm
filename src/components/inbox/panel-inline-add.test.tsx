import { describe, expect, it, vi } from "vitest"
import { renderToString } from "react-dom/server"

import { TeamNoteComposer } from "./team-note-composer"
import { CustomFieldValue } from "./custom-field-value"

// Both components are client components; rendering them to a string
// exercises the markup and the pt-BR copy (useLanguage falls back to the
// default catalogue without a provider). Effects never run here.
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => {
    throw new Error("createClient must only be called from handlers")
  },
}))

describe("TeamNoteComposer", () => {
  it("renders the pt-BR placeholder, Salvar and Cancelar", () => {
    const html = renderToString(
      <TeamNoteComposer onSubmit={async () => {}} onCancel={() => {}} />,
    )
    expect(html).toContain("Escreva uma nota interna…")
    expect(html).toContain(">Salvar<")
    expect(html).toContain(">Cancelar<")
    // Nothing typed yet → Salvar is disabled.
    expect(html).toMatch(/Ctrl\+Enter para salvar"[^>]*disabled/)
  })
})

const field = {
  id: "f1",
  user_id: "u",
  account_id: "a",
  field_name: "CEP",
  field_type: "text",
  created_at: "2026-01-01T00:00:00Z",
}

describe("CustomFieldValue", () => {
  it("shows the muted empty marker when the contact has no value", () => {
    const html = renderToString(
      <dl>
        <CustomFieldValue
          contactId="c1"
          field={field}
          value=""
          onSaved={() => {}}
          emptyLabel="—"
        />
      </dl>,
    )
    expect(html).toContain("CEP")
    expect(html).toContain("text-muted-foreground/60")
    expect(html).toContain(">—<")
    expect(html).toContain('title="Clique para editar"')
  })

  it("shows the stored value in foreground text", () => {
    const html = renderToString(
      <dl>
        <CustomFieldValue
          contactId="c1"
          field={field}
          value="01310-100"
          onSaved={() => {}}
          emptyLabel="—"
        />
      </dl>,
    )
    expect(html).toContain("01310-100")
    expect(html).not.toContain("text-muted-foreground/60")
  })

  it("renders read-only (no edit affordance) when disabled", () => {
    const html = renderToString(
      <dl>
        <CustomFieldValue
          contactId="c1"
          field={field}
          value=""
          onSaved={() => {}}
          emptyLabel="—"
          disabled
        />
      </dl>,
    )
    expect(html).not.toContain("Clique para editar")
    expect(html).toMatch(/<button[^>]*disabled/)
  })
})

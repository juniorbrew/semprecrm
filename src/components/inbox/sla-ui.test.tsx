import { describe, expect, it, vi } from "vitest"
import { renderToString } from "react-dom/server"

vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }))
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ accountId: "a-1", user: null, preferences: {} }) }))

import type { Conversation } from "@/types"
import type { Team } from "@/lib/support/teams"
import { SlaLine, SlaPill, SlaProgressLine } from "./sla-indicator"
import { TeamChip } from "./team-chip"
import { ConversationItem } from "./conversation-list"

const NOW = Date.parse("2026-03-02T15:00:00Z")
const at = (min: number) => new Date(NOW + min * 60_000).toISOString()
const policy = (over: Partial<Conversation> = {}): Conversation => ({
  id: "c1",
  user_id: "u",
  contact_id: "k",
  status: "open",
  unread_count: 0,
  created_at: at(-10),
  updated_at: at(-10),
  last_message_text: "oi",
  first_response_due_at: at(80),
  first_response_warn_at: at(64),
  resolution_due_at: at(480),
  resolution_warn_at: at(384),
  ...over,
})

// The list pieces tick on the shared list clock (read at render time), so
// their fixtures are relative to the real clock, with 30 s of slack.
const soon = (min: number) => new Date(Date.now() + min * 60_000 + 30_000).getTime()
const pill = (dueMin: number, warnMin: number | null, kind: "first_response" | "resolution" = "first_response") =>
  renderToString(<SlaPill kind={kind} dueAt={soon(dueMin)} warnAt={warnMin === null ? null : soon(warnMin)} />)

describe("SlaPill (list row)", () => {
  it("green pill with the time left while there is plenty", () => {
    // 100 min target, 80 left.
    const html = pill(80, 60)
    expect(html).toContain('data-testid="sla-row"')
    expect(html).toContain('data-tone="ok"')
    expect(html).toContain("SLA 1h 20min")
    expect(html).toContain("bg-emerald-500/15")
  })

  it("amber under 40% left, red under 15%", () => {
    // 100 min target (warn 20 min before due): 30 left / 10 left.
    expect(pill(30, 10)).toContain('data-tone="warn"')
    expect(pill(30, 10)).toContain("bg-amber-500/15")
    expect(pill(10, -10)).toContain('data-tone="critical"')
    expect(pill(10, -10)).toContain('data-level="warning"')
  })

  it("says it in words once breached, not only in colour", () => {
    const html = pill(-16, -36)
    expect(html).toContain('data-level="breached"')
    expect(html).toContain("estourado há 15min")
    expect(html).toContain("text-red-600")
    expect(html).not.toContain("SLA estourado")
  })

  it("titles the deadline it tracks", () => {
    expect(pill(480, 384, "resolution")).toContain('title="Prazo de resolução"')
  })
})

describe("SlaProgressLine", () => {
  it("draws the share left in the tone of the pill", () => {
    const html = renderToString(<SlaProgressLine kind="first_response" dueAt={soon(30)} warnAt={soon(10)} />)
    expect(html).toContain('data-testid="sla-progress"')
    expect(html).toContain('data-tone="warn"')
    expect(html).toMatch(/width:3[01]%/)
    expect(html).toContain('aria-hidden="true"')
  })

  it("draws nothing when the span is unknown (no warning stamp)", () => {
    expect(renderToString(<SlaProgressLine kind="first_response" dueAt={soon(30)} warnAt={null} />)).toBe("")
  })
})

describe("SlaLine (thread header)", () => {
  // The header ticks on the real clock, so its fixtures are relative to it.
  const live = (min: number) => new Date(Date.now() + min * 60_000).toISOString()
  const liveConv = (over: Partial<Conversation> = {}) =>
    policy({
      first_response_due_at: live(80),
      first_response_warn_at: live(64),
      resolution_due_at: live(480),
      resolution_warn_at: live(384),
      ...over,
    })

  it("names the deadline and keeps the state in words", () => {
    const html = renderToString(<SlaLine conversation={liveConv({ first_response_due_at: live(-30), first_response_warn_at: live(-40) })} />)
    expect(html).toContain("Prazo de resposta")
    expect(html).toContain("estourado há")
    expect(html).toContain('data-level="breached"')
    const res = renderToString(<SlaLine conversation={liveConv({ first_response_at: live(-5) })} />)
    expect(res).toContain("Prazo de resolução")
    expect(res).toContain('data-level="ok"')
    const warn = renderToString(<SlaLine conversation={liveConv({ first_response_warn_at: live(-1) })} />)
    expect(warn).toContain('data-level="warning"')
  })

  it("renders nothing when no deadline applies", () => {
    expect(renderToString(<SlaLine conversation={{ status: "open" }} />)).toBe("")
  })

  it("keeps to the design rules: no emoji, gradient, glow or all-caps", () => {
    const html = renderToString(<SlaLine conversation={liveConv()} />) + pill(80, 60)
    expect(html).not.toMatch(/gradient|shadow|uppercase|\p{Extended_Pictographic}/u)
  })
})

describe("ConversationItem SLA row", () => {
  const render = (c: Conversation, extra: { waitingLabel?: string | null } = {}) =>
    renderToString(
      <ConversationItem
        conversation={c}
        isActive={false}
        isCursor={false}
        ownerName={null}
        ownerTitle={() => ""}
        onSelect={() => {}}
        age="1 min"
        tags={[]}
        companyName={null}
        category={null}
        priorityLabel="Normal"
        rowStatus={{ pending: "Pendente", closed: "Resolvida", archived: "Arquivada" }}
        channelLabel="WhatsApp"
        channelChip={{ official: "Oficial", qr: "QR" }}
        moreTags={(n) => `+${n}`}
        waitingLabel={extra.waitingLabel ?? null}
        waitingTitle="Aguardando"
        queue={null}
      />,
    )

  it("shows the remaining time when a policy applies", () => {
    const html = render(policy({ first_response_due_at: new Date(soon(80)).toISOString(), first_response_warn_at: new Date(soon(64)).toISOString() }))
    expect(html).toContain('data-testid="sla-row"')
    expect(html).toContain("1h 20min")
    expect(html).toContain('data-testid="sla-progress"')
  })

  it("keeps the old wait pill behaviour when no policy applies", () => {
    const plain = policy({ first_response_due_at: null, resolution_due_at: null })
    const html = render(plain, { waitingLabel: "há 20 min" })
    expect(html).not.toContain("sla-row")
    expect(html).toContain("há 20 min")
  })
})

describe("TeamChip", () => {
  const teams: Team[] = [{ id: "t1", account_id: "a-1", name: "Financeiro", description: null, archived_at: null }]
  const byId = new Map(teams.map((t) => [t.id, t]))

  it("agents get a popover trigger with the team name, or a placeholder", () => {
    const set = renderToString(<TeamChip teamId="t1" teams={teams} byId={byId} canEdit onChange={() => {}} />)
    expect(set).toContain("Financeiro")
    expect(set).toContain('aria-label="Equipe"')
    expect(set).toContain('data-testid="team-chip"')
    const empty = renderToString(<TeamChip teamId={null} teams={teams} byId={byId} canEdit onChange={() => {}} />)
    expect(empty).toContain("Equipe")
  })

  it("viewers read only: a plain chip, and nothing when there is no team", () => {
    const set = renderToString(<TeamChip teamId="t1" teams={teams} byId={byId} canEdit={false} onChange={() => {}} />)
    expect(set).toContain("Financeiro")
    expect(set).not.toContain("<button")
    expect(renderToString(<TeamChip teamId={null} teams={teams} byId={byId} canEdit={false} onChange={() => {}} />)).toBe("")
  })

  it("an archived team keeps its name on old conversations", () => {
    const archived = new Map([["t1", { ...teams[0], archived_at: "2026-01-01" }]])
    expect(renderToString(<TeamChip teamId="t1" teams={[]} byId={archived} canEdit={false} onChange={() => {}} />)).toContain("Financeiro")
  })
})

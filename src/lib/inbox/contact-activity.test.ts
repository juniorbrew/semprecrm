import { describe, expect, it, vi } from "vitest"

import { describeActivity, fetchContactActivity, type ContactActivityRow } from "./contact-activity"

const row = (over: Partial<ContactActivityRow>): ContactActivityRow => ({
  id: "r1",
  type: "note",
  at: "2026-09-30T10:00:00Z",
  title: "Oi",
  payload: null,
  actor_name: null,
  link_kind: "note",
  link_id: null,
  conversation_id: null,
  ...over,
})

describe("describeActivity", () => {
  it("formats deal, task, campaign rows with a link", () => {
    expect(describeActivity(row({ type: "deal_won", title: "X", link_kind: "deal", link_id: "d1" }), "pt-BR")).toEqual({
      icon: "won",
      text: "Negócio X ganho",
      href: "/pipelines?deal=d1",
    })
    expect(describeActivity(row({ type: "campaign_failed", title: "BF", link_kind: "broadcast", link_id: "b" }), "en-US")?.text).toBe(
      "Campaign BF failed to send",
    )
    expect(describeActivity(row({ type: "task_done", title: "Ligar", actor_name: "Ana", link_kind: "task", link_id: "t" }), "pt-BR")?.text).toBe(
      "Tarefa concluída: Ligar · Ana",
    )
  })
  it("reuses the thread copy for conversation events and links the conversation", () => {
    const v = describeActivity(
      row({
        type: "conv_deal_stage_changed",
        title: "X",
        payload: { deal_title: "X", from_stage_name: "Novo", to_stage_name: "Proposta" },
        actor_name: "Ana",
        link_kind: "conversation",
        link_id: "c1",
        conversation_id: "c1",
      }),
      "pt-BR",
    )
    expect(v).toEqual({ icon: "deal", text: "Negócio X movido de Novo para Proposta por Ana", href: "/inbox?c=c1" })
  })
  it("drops unknown types", () => {
    expect(describeActivity(row({ type: "mystery" }), "pt-BR")).toBeNull()
  })
})

describe("fetchContactActivity", () => {
  it("calls the RPC with paging args and throws on error", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [row({})], error: null })
    await fetchContactActivity({ rpc } as never, "c1", { before: "2026-01-01T00:00:00Z" })
    expect(rpc).toHaveBeenCalledWith("contact_activity", { p_contact_id: "c1", p_limit: 20, p_before: "2026-01-01T00:00:00Z" })
    rpc.mockResolvedValue({ data: null, error: new Error("x") })
    await expect(fetchContactActivity({ rpc } as never, "c1")).rejects.toThrow("x")
  })
})

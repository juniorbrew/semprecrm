import { describe, expect, it, vi } from "vitest"

import type { PipelineStage } from "@/types"
import { checkDealMove, moveDealToStage } from "./move-deal"

const stage = (id: string, name: string, pipeline_id = "p1"): PipelineStage => ({
  id,
  pipeline_id,
  name,
  position: 0,
  color: "#000",
  created_at: "",
})
const stages = [stage("s1", "Novo"), stage("s2", "Proposta"), stage("x1", "Outro funil", "p2")]
const deal = { id: "d1", title: "Deal X", stage_id: "s1", pipeline_id: "p1" }

function fakeClient(updateError: unknown = null, rows: unknown[] = [{ id: "d1" }]) {
  const select = vi.fn().mockResolvedValue({ data: updateError ? null : rows, error: updateError })
  const eq = vi.fn().mockReturnValue({ select })
  const update = vi.fn().mockReturnValue({ eq })
  const single = vi.fn().mockResolvedValue({ data: { id: "e1" }, error: null })
  const insert = vi.fn().mockReturnValue({ select: () => ({ single }) })
  const from = vi.fn((table: string) => (table === "deals" ? { update } : { insert }))
  return { client: { from } as never, update, eq, insert }
}

const base = { deal, stages, accountId: "a1", conversationId: "c1", actorId: "u1", actorName: "Ana" }

describe("checkDealMove", () => {
  it("allows another stage of the same pipeline only", () => {
    expect(checkDealMove(deal, "s2", stages)).toBe("ok")
    expect(checkDealMove(deal, "s1", stages)).toBe("same-stage")
    expect(checkDealMove(deal, "x1", stages)).toBe("foreign-stage")
    expect(checkDealMove(deal, "nope", stages)).toBe("foreign-stage")
  })
})

describe("moveDealToStage", () => {
  it("updates stage_id like the board and logs the conversation event", async () => {
    const { client, update, eq, insert } = fakeClient()
    const to = await moveDealToStage(client, { ...base, toStageId: "s2" })
    expect(to.id).toBe("s2")
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ stage_id: "s2" }))
    expect(update.mock.calls[0][0]).not.toHaveProperty("status")
    expect(eq).toHaveBeenCalledWith("id", "d1")
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({
        conversation_id: "c1",
        event_type: "deal_stage_changed",
        payload: expect.objectContaining({ deal_title: "Deal X", from_stage_name: "Novo", to_stage_name: "Proposta" }),
      }),
    )
  })

  it("skips the event without an active conversation", async () => {
    const { client, insert } = fakeClient()
    await moveDealToStage(client, { ...base, conversationId: null, toStageId: "s2" })
    expect(insert).not.toHaveBeenCalled()
  })

  it("rejects illegal moves without touching the database", async () => {
    const { client, update } = fakeClient()
    await expect(moveDealToStage(client, { ...base, toStageId: "x1" })).rejects.toThrow(/foreign-stage/)
    await expect(moveDealToStage(client, { ...base, toStageId: "s1" })).rejects.toThrow(/same-stage/)
    expect(update).not.toHaveBeenCalled()
  })

  it("treats an update that matched no row (RLS) as a failure: no event", async () => {
    const { client, insert } = fakeClient(null, [])
    await expect(moveDealToStage(client, { ...base, toStageId: "s2" })).rejects.toThrow(/not persisted/)
    expect(insert).not.toHaveBeenCalled()
  })

  it("throws and logs nothing when the update fails", async () => {
    const { client, insert } = fakeClient({ message: "rls" })
    await expect(moveDealToStage(client, { ...base, toStageId: "s2" })).rejects.toBeTruthy()
    expect(insert).not.toHaveBeenCalled()
  })
})

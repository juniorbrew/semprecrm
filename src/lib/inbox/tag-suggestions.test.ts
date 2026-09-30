import { describe, expect, it } from "vitest"

import type { Tag } from "@/types"
import { rankTagSuggestions } from "./tag-suggestions"

const tag = (id: string, name: string) => ({ id, name, color: "#000" }) as Tag

describe("rankTagSuggestions", () => {
  const all = [tag("a", "Alfa"), tag("b", "Beta"), tag("c", "Gama"), tag("d", "Delta")]
  it("orders by usage then name and skips applied tags", () => {
    const out = rankTagSuggestions(all, { c: 9, b: 5, a: 5 }, new Set(["c"]))
    expect(out.map((t) => t.id)).toEqual(["a", "b", "d"])
  })
  it("caps at the limit (default 8)", () => {
    const many = Array.from({ length: 12 }, (_, i) => tag(String(i), `T${String(i).padStart(2, "0")}`))
    expect(rankTagSuggestions(many, {}, new Set())).toHaveLength(8)
    expect(rankTagSuggestions(many, {}, new Set(), 3)).toHaveLength(3)
  })
})

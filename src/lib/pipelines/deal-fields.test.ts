import { describe, expect, it } from "vitest"

import { parseDealValue, validateDealFields } from "./deal-fields"

describe("parseDealValue", () => {
  it("accepts pt-BR and plain decimals", () => {
    expect(parseDealValue("1.234,56")).toBe(1234.56)
    expect(parseDealValue("1234.5")).toBe(1234.5)
    expect(parseDealValue("")).toBe(0)
  })
  it("rejects garbage and negatives", () => {
    expect(parseDealValue("abc")).toBeNull()
    expect(parseDealValue("-5")).toBeNull()
    expect(parseDealValue("1,234,5")).toBeNull()
  })
})

describe("validateDealFields", () => {
  it("builds a patch, nulling empty optionals", () => {
    const r = validateDealFields({ value: "10", expected_close_date: "", notes: "  " })
    expect(r).toEqual({ ok: true, patch: { value: 10, expected_close_date: null, notes: null } })
  })
  it("reports every invalid field", () => {
    const r = validateDealFields({ value: "x", expected_close_date: "2026-13-40", notes: "n".repeat(2001) })
    expect(r).toEqual({ ok: false, errors: ["value", "date", "notes"] })
  })
})

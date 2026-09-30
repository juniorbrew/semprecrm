import { describe, expect, it } from "vitest"

import { DEAL_VALUE_MAX, parseDealValue, validateDealFields } from "./deal-fields"

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
  it("matches NUMERIC(12,2): max 9.999.999.999,99, one cent more overflows", () => {
    expect(DEAL_VALUE_MAX).toBe(9999999999.99)
    expect(parseDealValue("9.999.999.999,99")).toBe(9999999999.99)
    expect(parseDealValue("10.000.000.000,00")).toBe("overflow")
  })
})

describe("validateDealFields", () => {
  const draft = { value: "10", expected_close_date: "", notes: "  " }
  it("builds a patch, nulling empty optionals", () => {
    expect(validateDealFields(draft)).toEqual({
      ok: true,
      patch: { value: 10, expected_close_date: null, notes: null },
    })
  })
  it("sends only the dirty fields", () => {
    expect(validateDealFields({ ...draft, value: "5" }, { value: true })).toEqual({ ok: true, patch: { value: 5 } })
    expect(validateDealFields(draft, {})).toEqual({ ok: true, patch: {} })
  })
  it("reports every invalid field, with a distinct code for overflow", () => {
    expect(validateDealFields({ value: "x", expected_close_date: "2026-13-40", notes: "n".repeat(2001) })).toEqual({
      ok: false,
      errors: ["value", "date", "notes"],
    })
    expect(validateDealFields({ ...draft, value: "99999999999" })).toEqual({ ok: false, errors: ["value-max"] })
  })
  it("checks notes length only when notes were edited", () => {
    const long = { value: "7", expected_close_date: "", notes: "n".repeat(2500) }
    expect(validateDealFields(long, { value: true })).toEqual({ ok: true, patch: { value: 7 } })
    expect(validateDealFields(long, { notes: true })).toEqual({ ok: false, errors: ["notes"] })
  })
})

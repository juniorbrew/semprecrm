import { beforeEach, describe, expect, it, vi } from "vitest";

// ------------------------------------------------------------
// PATCH /api/account — rename + pessoa física / jurídica registration.
//
// Mocks the account context and a minimal `accounts` update builder so
// the route's validation and the payload it writes are what's tested.
// ------------------------------------------------------------

const h = vi.hoisted(() => ({
  state: {
    account: {
      id: "acct-1",
      name: "Acme",
      person_type: "pf",
      tax_id: null as string | null,
      legal_name: null as string | null,
    },
    updates: [] as Record<string, unknown>[],
    audits: [] as Record<string, unknown>[],
  },
}));

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/audit-server", () => ({
  audit: vi.fn(async (entry: Record<string, unknown>) => {
    h.state.audits.push(entry);
  }),
}));

function makeSupabase() {
  return {
    from: (table: string) => {
      if (table !== "accounts") throw new Error(`unexpected table ${table}`);
      let payload: Record<string, unknown> = {};
      const b = {
        update: (p: Record<string, unknown>) => {
          payload = p;
          h.state.updates.push(p);
          return b;
        },
        eq: () => b,
        select: () => b,
        single: async () => ({ data: { ...h.state.account, ...payload }, error: null }),
      };
      return b;
    },
  };
}

vi.mock("@/lib/auth/account", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/account")>();
  return {
    ...actual,
    requireRole: vi.fn(async () => ({
      supabase: makeSupabase(),
      userId: "user-1",
      accountId: "acct-1",
      role: "owner",
      account: { ...h.state.account },
    })),
  };
});

import { PATCH } from "./route";

function patch(body: unknown) {
  return PATCH(
    new Request("http://localhost/api/account", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  h.state.account = { id: "acct-1", name: "Acme", person_type: "pf", tax_id: null, legal_name: null };
  h.state.updates = [];
  h.state.audits = [];
});

describe("PATCH /api/account", () => {
  it("still renames with a name-only body", async () => {
    const res = await patch({ name: "  Acme Ltda " });
    expect(res.status).toBe(200);
    expect(h.state.updates).toEqual([{ name: "Acme Ltda" }]);
    expect(h.state.audits.map((a) => a.action)).toEqual(["account.renamed"]);
  });

  it("stores a normalised pessoa jurídica registration", async () => {
    const res = await patch({
      person_type: "pj",
      tax_id: "11.222.333/0001-81",
      legal_name: " Padaria Sol Ltda ",
      name: "Padaria do Sol",
    });
    expect(res.status).toBe(200);
    expect(h.state.updates).toEqual([
      { name: "Padaria do Sol", person_type: "pj", tax_id: "11222333000181", legal_name: "Padaria Sol Ltda" },
    ]);
    expect(h.state.audits.map((a) => a.action).sort()).toEqual(["account.registration_updated", "account.renamed"]);
    const body = await res.json();
    expect(body.account).toMatchObject({ person_type: "pj", tax_id: "11222333000181" });
  });

  it("clears the legal name when switching to pessoa física", async () => {
    h.state.account.person_type = "pj";
    h.state.account.legal_name = "Padaria Sol Ltda";
    const res = await patch({ person_type: "pf", tax_id: "529.982.247-25", legal_name: "Padaria Sol Ltda" });
    expect(res.status).toBe(200);
    expect(h.state.updates).toEqual([{ person_type: "pf", tax_id: "52998224725", legal_name: null }]);
  });

  it("rejects an invalid document with per-field error codes", async () => {
    const res = await patch({ person_type: "pj", tax_id: "11222333000182", legal_name: "" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "Invalid registration data",
      errors: { tax_id: "invalid", legal_name: "required" },
    });
    expect(h.state.updates).toEqual([]);
  });

  it("requires the document whenever the person type is sent", async () => {
    const res = await patch({ person_type: "pj" });
    expect(res.status).toBe(400);
    expect((await res.json()).errors).toEqual({ tax_id: "required", legal_name: "required" });
  });

  it("does not audit a registration write that changed nothing", async () => {
    h.state.account.tax_id = "52998224725";
    const res = await patch({ person_type: "pf", tax_id: "529.982.247-25" });
    expect(res.status).toBe(200);
    expect(h.state.audits).toEqual([]);
  });

  it("rejects an empty body", async () => {
    const res = await patch({});
    expect(res.status).toBe(400);
  });
});

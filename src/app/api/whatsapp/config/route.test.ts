import { beforeEach, describe, expect, it, vi } from "vitest";

// ------------------------------------------------------------
// POST /api/whatsapp/config — plan gates (migration 025).
//
//   - `channel_official` module must be on (basico lacks it)
//   - a NEW channel must fit under `max_channels`
//   - re-saving the existing row is not a new channel
// ------------------------------------------------------------

const h = vi.hoisted(() => ({
  state: {
    account: {
      plan: "trial",
      plan_status: "trial",
      plan_expires_at: null as string | null,
      module_overrides: {} as Record<string, unknown>,
      limit_overrides: {} as Record<string, unknown>,
    },
    /** Existing whatsapp_config row for the account (null = none). */
    existing: null as Record<string, unknown> | null,
    channels: 0,
    writes: [] as { type: string; payload: unknown }[],
  },
}));

function userBuilder(table: string) {
  const ops = { count: false, type: "select" as string, payload: undefined as unknown };
  const b: Record<string, unknown> = {
    select: (_cols: string, opts?: { count?: string }) => {
      if (opts?.count) ops.count = true;
      return b;
    },
    insert: (p: unknown) => ((ops.type = "insert"), (ops.payload = p), b),
    update: (p: unknown) => ((ops.type = "update"), (ops.payload = p), b),
    eq: () => b,
    neq: () => b,
    maybeSingle: () => Promise.resolve(resolve()),
    single: () => Promise.resolve(resolve()),
    then: (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
      Promise.resolve(resolve()).then(onF, onR),
  };
  function resolve() {
    if (table === "profiles") return { data: { account_id: "acct-1" }, error: null };
    if (table === "accounts") return { data: h.state.account, error: null };
    if (table === "whatsapp_config") {
      if (ops.type === "insert" || ops.type === "update") {
        h.state.writes.push({ type: ops.type, payload: ops.payload });
        return { data: null, error: null };
      }
      if (ops.count) return { data: null, count: h.state.channels, error: null };
      return { data: h.state.existing, error: null };
    }
    return { data: null, error: null };
  }
  return b;
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: "user-1" } }, error: null }) },
    from: (table: string) => userBuilder(table),
  }),
}));

// Service-role client — only used for the cross-account
// phone_number_id conflict check; always "not claimed" here.
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: () => {
      const b: Record<string, unknown> = {
        select: () => b,
        eq: () => b,
        neq: () => b,
        maybeSingle: () => Promise.resolve({ data: null, error: null }),
      };
      return b;
    },
  }),
}));

vi.mock("@/lib/whatsapp/meta-api", () => ({
  verifyPhoneNumber: vi.fn(async () => ({ display_phone_number: "+55 11 99999-0000" })),
  registerPhoneNumber: vi.fn(async () => ({})),
  subscribeWabaToApp: vi.fn(async () => ({})),
}));

import { POST } from "./route";

function request(body: unknown) {
  return new Request("http://localhost/api/whatsapp/config", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const VALID = {
  phone_number_id: "123456",
  waba_id: "789",
  access_token: "EAAB-token",
  verify_token: "verify",
};

beforeEach(() => {
  h.state.account = {
    plan: "trial",
    plan_status: "trial",
    plan_expires_at: null,
    module_overrides: {},
    limit_overrides: {},
  };
  h.state.existing = null;
  h.state.channels = 0;
  h.state.writes = [];
});

describe("POST /api/whatsapp/config — plan gates", () => {
  it("saves a first channel on trial (max_channels = 1, 0 in use)", async () => {
    const res = await POST(request(VALID));
    expect(res.status).toBe(200);
    expect(h.state.writes).toHaveLength(1);
    expect(h.state.writes[0].type).toBe("insert");
  });

  it("refuses a new channel when max_channels is reached", async () => {
    h.state.channels = 1; // trial allows 1
    const res = await POST(request(VALID));
    expect(res.status).toBe(403);
    const json = (await res.json()) as { code?: string };
    expect(json.code).toBe("plan_limit_reached");
    expect(h.state.writes).toHaveLength(0);
  });

  it("re-saving the existing row is not a new channel", async () => {
    h.state.channels = 1;
    h.state.existing = { id: "cfg-1", registered_at: null, phone_number_id: "123456" };
    const res = await POST(request(VALID));
    expect(res.status).toBe(200);
    expect(h.state.writes[0].type).toBe("update");
  });

  it("refuses when the plan lacks channel_official (basico)", async () => {
    h.state.account.plan = "basico";
    h.state.account.plan_status = "active";
    const res = await POST(request(VALID));
    expect(res.status).toBe(403);
    const json = (await res.json()) as { code?: string };
    expect(json.code).toBe("module_not_included");
  });

  it("refuses when the account is blocked", async () => {
    h.state.account.plan_status = "suspended";
    const res = await POST(request(VALID));
    expect(res.status).toBe(403);
  });

  it("honours a limit override for max_channels", async () => {
    h.state.channels = 1;
    h.state.account.limit_overrides = { max_channels: 3 };
    const res = await POST(request(VALID));
    expect(res.status).toBe(200);
  });
});

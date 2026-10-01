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
    role: "admin" as string,
    /** phone_number_id already held by another account. */
    claimed: false,
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
    if (table === "profiles") {
      return {
        data: { account_id: "acct-1", account_role: h.state.role, account: { id: "acct-1", name: "Acme" } },
        error: null,
      };
    }
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
        maybeSingle: () =>
          Promise.resolve({ data: h.state.claimed ? { account_id: "acct-other" } : null, error: null }),
      };
      return b;
    },
  }),
}));

vi.mock("@/lib/whatsapp/meta-api", () => ({
  verifyPhoneNumber: vi.fn(async () => ({ display_phone_number: "+55 11 99999-0000" })),
  registerPhoneNumber: vi.fn(async () => ({})),
  subscribeWabaToApp: vi.fn(async () => ({})),
  // wacrm #505: the number must be listed under the WABA.
  listWabaPhoneNumbers: vi.fn(async () => [{ id: "123456", display_phone_number: "+55 11 99999-0000" }]),
  getSubscribedApps: vi.fn(async () => []),
}));

import { __resetRateLimitForTests } from "@/lib/rate-limit";
import { DELETE, POST } from "./route";
import * as metaApi from "@/lib/whatsapp/meta-api";

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
  h.state.role = "admin";
  h.state.claimed = false;
  h.state.writes = [];
  __resetRateLimitForTests();
  vi.mocked(metaApi.verifyPhoneNumber).mockReset();
  vi.mocked(metaApi.verifyPhoneNumber).mockImplementation(
    async () => ({ id: "123456", display_phone_number: "+55 11 99999-0000" }),
  );
  vi.mocked(metaApi.listWabaPhoneNumbers).mockReset();
  vi.mocked(metaApi.listWabaPhoneNumbers).mockImplementation(async () => [
    { id: "123456", display_phone_number: "+55 11 99999-0000" },
  ]);
  vi.mocked(metaApi.subscribeWabaToApp).mockReset();
  vi.mocked(metaApi.subscribeWabaToApp).mockImplementation(async () => {});
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

// ------------------------------------------------------------
// wacrm #505 — explain why a Meta connection fails, validate the
// WABA / phone pairing, and (SempreCRM) ship a pt-BR rendition.
// ------------------------------------------------------------
type ConfigError = {
  error?: string;
  error_pt?: string;
  field?: string;
  meta?: { code: number | null; step: string; field: string | null; fbtrace_id: string | null };
};

function metaError(message: string, fields: Record<string, unknown>) {
  return Object.assign(new Error(message), { httpStatus: 400, ...fields });
}

describe("POST /api/whatsapp/config — Meta connection errors (wacrm #505)", () => {
  it("rejects a non-numeric Phone Number ID before calling Meta", async () => {
    const res = await POST(request({ ...VALID, phone_number_id: "+55 11 99999-0000" }));
    expect(res.status).toBe(400);
    const json = (await res.json()) as ConfigError;
    expect(json.field).toBe("phone_number_id");
    expect(metaApi.verifyPhoneNumber).not.toHaveBeenCalled();
  });

  it("rejects a non-numeric WABA ID", async () => {
    const res = await POST(request({ ...VALID, waba_id: "minha-waba" }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as ConfigError).field).toBe("waba_id");
  });

  it("explains an Unsupported get request on the phone number, in both languages", async () => {
    vi.mocked(metaApi.verifyPhoneNumber).mockRejectedValue(
      metaError("Unsupported get request. Object with ID '123456' does not exist", {
        code: 100,
        subcode: 33,
        fbtraceId: "TRACE",
      }),
    );
    const res = await POST(request(VALID));
    expect(res.status).toBe(400);
    const json = (await res.json()) as ConfigError;
    expect(json.error).toMatch(/cannot find Phone Number ID 123456/);
    expect(json.error_pt).toMatch(/não encontra o ID do número de telefone 123456/);
    expect(json.meta).toMatchObject({
      code: 100,
      step: "verify_number",
      field: "phone_number_id",
      fbtrace_id: "TRACE",
    });
    expect(h.state.writes).toHaveLength(0);
  });

  it("refuses a phone number that is not listed under the WABA", async () => {
    vi.mocked(metaApi.listWabaPhoneNumbers).mockResolvedValue([
      { id: "999", display_phone_number: "+55 21 5555-0000" },
    ]);
    const res = await POST(request(VALID));
    expect(res.status).toBe(400);
    const json = (await res.json()) as ConfigError;
    expect(json.field).toBe("waba_id");
    expect(json.error).toMatch(/does not belong to WhatsApp Business Account 789/);
    expect(json.error_pt).toMatch(/não pertence à conta do WhatsApp Business 789/);
    expect(json.meta?.step).toBe("waba_phone_numbers");
    expect(metaApi.subscribeWabaToApp).not.toHaveBeenCalled();
    expect(h.state.writes).toHaveLength(0);
  });

  it("saves anyway and warns (en + pt-BR) when subscribed_apps fails", async () => {
    vi.mocked(metaApi.subscribeWabaToApp).mockRejectedValue(
      metaError("(#200) Permissions error", { code: 200 }),
    );
    const res = await POST(request({ ...VALID, pin: "123456" }));
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      saved?: boolean;
      warning?: ConfigError;
      warnings?: ConfigError[];
    };
    expect(json.saved).toBe(true);
    expect(json.warning?.meta).toMatchObject({ step: "subscribe_waba", field: "access_token" });
    expect(json.warning?.error_pt).toMatch(/whatsapp_business_management/);
    expect(json.warnings).toHaveLength(1);
    // /register ran before the subscribe step — its outcome is recorded.
    expect(h.state.writes).toHaveLength(1);
    const row = h.state.writes[0].payload as Record<string, unknown>;
    expect(row.subscribed_apps_at).toBeNull();
    expect(row.registered_at).toEqual(expect.any(String));
    expect(row.last_registration_error).toBeNull();
  });

  it("saves anyway and warns when the WABA phone list cannot be fetched", async () => {
    vi.mocked(metaApi.listWabaPhoneNumbers).mockRejectedValue(
      metaError("Service temporarily unavailable", { code: 2, httpStatus: 503 }),
    );
    const res = await POST(request(VALID));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { warning?: ConfigError };
    expect(json.warning?.meta?.step).toBe("waba_phone_numbers");
    expect(json.warning?.error_pt).toBeTruthy();
    expect(metaApi.subscribeWabaToApp).toHaveBeenCalledTimes(1);
    expect(h.state.writes).toHaveLength(1);
    const row = h.state.writes[0].payload as Record<string, unknown>;
    expect(row.subscribed_apps_at).toEqual(expect.any(String));
  });

  it("returns no warning on a clean save", async () => {
    const res = await POST(request(VALID));
    const json = (await res.json()) as { warning?: unknown };
    expect(json.warning).toBeUndefined();
  });

  const WIRED = {
    id: "cfg-1",
    registered_at: "2026-01-01T00:00:00Z",
    phone_number_id: "123456",
    waba_id: "789",
    subscribed_apps_at: "2026-01-01T00:00:00Z",
  };

  it("skips only the pairing check for an unchanged, already-subscribed WABA/number — still re-subscribes", async () => {
    h.state.existing = { ...WIRED };
    const res = await POST(request(VALID));
    expect(res.status).toBe(200);
    expect(metaApi.listWabaPhoneNumbers).not.toHaveBeenCalled();
    // "Save again to resubscribe" must not be a silent no-op.
    expect(metaApi.subscribeWabaToApp).toHaveBeenCalledTimes(1);
    const row = h.state.writes[0].payload as Record<string, unknown>;
    expect(row.subscribed_apps_at).toEqual(expect.any(String));
    expect(row.subscribed_apps_at).not.toBe(WIRED.subscribed_apps_at);
  });

  it("still warns (and clears subscribed_apps_at) when re-subscribing an unchanged pair fails", async () => {
    h.state.existing = { ...WIRED };
    vi.mocked(metaApi.subscribeWabaToApp).mockRejectedValue(
      metaError("(#200) Permissions error", { code: 200 }),
    );
    const res = await POST(request(VALID));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { warning?: ConfigError };
    expect(json.warning?.meta?.step).toBe("subscribe_waba");
    expect(json.warning?.error_pt).toBeTruthy();
    const row = h.state.writes[0].payload as Record<string, unknown>;
    expect(row.subscribed_apps_at).toBeNull();
  });

  it("re-checks when the WABA changed", async () => {
    h.state.existing = {
      id: "cfg-1",
      registered_at: "2026-01-01T00:00:00Z",
      phone_number_id: "123456",
      waba_id: "111",
      subscribed_apps_at: "2026-01-01T00:00:00Z",
    };
    await POST(request(VALID));
    expect(metaApi.listWabaPhoneNumbers).toHaveBeenCalledTimes(1);
    expect(metaApi.subscribeWabaToApp).toHaveBeenCalledTimes(1);
  });

  it("maps a network failure to a 502", async () => {
    vi.mocked(metaApi.verifyPhoneNumber).mockRejectedValue(new TypeError("fetch failed"));
    const res = await POST(request(VALID));
    expect(res.status).toBe(502);
    expect(((await res.json()) as ConfigError).error_pt).toMatch(/graph\.facebook\.com/);
  });
});

describe("/api/whatsapp/config — role and disclosure", () => {
  it("refuses a non-admin before any Meta call", async () => {
    for (const role of ["agent", "viewer"]) {
      h.state.role = role;
      const res = await POST(request(VALID));
      expect(res.status).toBe(403);
    }
    expect(metaApi.verifyPhoneNumber).not.toHaveBeenCalled();
    expect(h.state.writes).toHaveLength(0);
  });

  it("refuses DELETE for a non-admin", async () => {
    h.state.role = "agent";
    expect((await DELETE()).status).toBe(403);
  });

  it("answers a generic 409 when the number belongs to another account", async () => {
    h.state.claimed = true;
    const res = await POST(request(VALID));
    expect(res.status).toBe(409);
    const json = (await res.json()) as ConfigError;
    expect(json.error).not.toMatch(/another account|already linked/i);
    expect(metaApi.verifyPhoneNumber).not.toHaveBeenCalled();
  });
});

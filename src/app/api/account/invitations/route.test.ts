import { beforeEach, describe, expect, it, vi } from "vitest";

// ------------------------------------------------------------
// POST /api/account/invitations — plan limit (`max_users`).
//
// Mocks the account context (`requireRole`) and a minimal Supabase
// query builder so the route's own logic — count members + pending
// invites, compare against the plan — is what's under test.
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
    members: 1,
    pendingInvites: 0,
    inserted: [] as unknown[],
  },
}));

// The SSR client reads next/headers cookies — never available in a
// unit test, so replace the module wholesale.
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));

function makeSupabase() {
  function builder(table: string) {
    const ops = { count: false, head: false, type: "select" as "select" | "insert" };
    const b: Record<string, unknown> = {
      select: (_cols: string, opts?: { count?: string; head?: boolean }) => {
        if (opts?.count) ops.count = true;
        if (opts?.head) ops.head = true;
        return b;
      },
      insert: (payload: unknown) => {
        ops.type = "insert";
        h.state.inserted.push(payload);
        return b;
      },
      eq: () => b,
      is: () => b,
      gt: () => b,
      order: () => b,
      maybeSingle: () => Promise.resolve(resolve()),
      single: () => Promise.resolve(resolve()),
      then: (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
        Promise.resolve(resolve()).then(onF, onR),
    };
    function resolve() {
      if (table === "accounts") return { data: h.state.account, error: null };
      if (table === "profiles" && ops.count) {
        return { data: null, count: h.state.members, error: null };
      }
      if (table === "account_invitations") {
        if (ops.type === "insert") {
          return {
            data: {
              id: "inv-1",
              role: "agent",
              label: null,
              expires_at: "2026-09-19T00:00:00.000Z",
              created_at: "2026-09-12T00:00:00.000Z",
            },
            error: null,
          };
        }
        if (ops.count) return { data: null, count: h.state.pendingInvites, error: null };
      }
      return { data: null, error: null };
    }
    return b;
  }
  return { from: (table: string) => builder(table) };
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
      account: { id: "acct-1", name: "Acme" },
    })),
  };
});

import { POST } from "./route";

function request(body: unknown) {
  return new Request("http://localhost/api/account/invitations", {
    method: "POST",
    headers: { "content-type": "application/json", host: "localhost" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  h.state.account = {
    plan: "trial",
    plan_status: "trial",
    plan_expires_at: null,
    module_overrides: {},
    limit_overrides: {},
  };
  h.state.members = 1;
  h.state.pendingInvites = 0;
  h.state.inserted = [];
});

describe("POST /api/account/invitations — max_users", () => {
  it("creates an invite while under the limit (trial: 2 seats, 1 member)", async () => {
    const res = await POST(request({ role: "agent" }));
    expect(res.status).toBe(201);
    expect(h.state.inserted).toHaveLength(1);
  });

  it("refuses when members + pending invites reach max_users", async () => {
    h.state.members = 1;
    h.state.pendingInvites = 1; // 1 + 1 >= 2
    const res = await POST(request({ role: "agent" }));
    expect(res.status).toBe(403);
    const json = (await res.json()) as { code?: string; error: string };
    expect(json.code).toBe("plan_limit_reached");
    expect(json.error).toContain("2");
    expect(h.state.inserted).toHaveLength(0);
  });

  it("refuses when the account is already full of members", async () => {
    h.state.members = 2;
    const res = await POST(request({ role: "viewer" }));
    expect(res.status).toBe(403);
    expect(h.state.inserted).toHaveLength(0);
  });

  it("honours a limit override", async () => {
    h.state.members = 2;
    h.state.account.limit_overrides = { max_users: 5 };
    const res = await POST(request({ role: "agent" }));
    expect(res.status).toBe(201);
  });

  it("treats max_users = null as unlimited (empresa)", async () => {
    h.state.account.plan = "empresa";
    h.state.account.plan_status = "active";
    h.state.members = 250;
    h.state.pendingInvites = 40;
    const res = await POST(request({ role: "agent" }));
    expect(res.status).toBe(201);
  });
});

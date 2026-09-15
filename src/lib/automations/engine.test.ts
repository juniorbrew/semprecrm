import { describe, it, expect, beforeEach, vi } from "vitest";

// Shared mock state for the service-role client. Lives in a hoisted block
// so the vi.mock factory below can close over it.
const h = vi.hoisted(() => ({
  state: {
    owned: null as { id: string } | null,
    account: { plan: "trial", plan_status: "trial", plan_expires_at: null, module_overrides: {}, limit_overrides: {} } as Record<string, unknown> | null,
    ownedCustomField: null as { id: string } | null,
    automations: [] as Record<string, unknown>[],
    steps: [] as Record<string, unknown>[],
    fromCalls: [] as string[],
    updateCalls: [] as { table: string; filters: [string, string, unknown][] }[],
    upsertCalls: [] as { table: string; payload: unknown }[],
    // create_task: the account's task_statuses, the member lookup for
    // the assignee, and every row inserted into `tasks`.
    taskStatuses: [] as Record<string, unknown>[],
    member: null as { user_id: string } | null,
    insertCalls: [] as { table: string; payload: unknown }[],
    logResults: [] as unknown[],
  },
}));

vi.mock("./admin-client", () => {
  const { state } = h;

  function resolve(ops: {
    table: string;
    type: string;
    payload?: unknown;
    filters: [string, string, unknown][];
  }) {
    const { table, type } = ops;
    if (table === "contacts") {
      if (type === "update") {
        state.updateCalls.push({ table, filters: ops.filters });
        return { data: null, error: null };
      }
      // ownership guard / condition read
      return { data: state.owned, error: null };
    }
    if (table === "custom_fields") {
      // account-scoped ownership lookup for a custom field definition
      return { data: state.ownedCustomField, error: null };
    }
    if (table === "contact_custom_values") {
      if (type === "upsert") {
        state.upsertCalls.push({ table, payload: ops.payload });
        return { data: null, error: null };
      }
      return { data: null, error: null };
    }
    if (table === "accounts") {
      // Plan gate (migration 025) — default to an unexpired trial so
      // every existing scenario keeps running; a test can flip
      // `state.account` to exercise the "module off" path.
      return { data: state.account, error: null };
    }
    if (table === "automations") return { data: state.automations, error: null };
    if (table === "automation_logs") {
      if (type === "insert") return { data: { id: "log1" }, error: null };
      if (type === "update") {
        const p = ops.payload as { steps_executed?: unknown[] } | undefined;
        if (p?.steps_executed) state.logResults = p.steps_executed;
        return { data: null, error: null };
      }
      return { data: { steps_executed: [], status: "success" }, error: null };
    }
    if (table === "automation_steps") return { data: state.steps, error: null };
    if (table === "task_statuses") return { data: state.taskStatuses, error: null };
    if (table === "profiles") return { data: state.member, error: null };
    if (table === "tasks" && type === "insert") {
      state.insertCalls.push({ table, payload: ops.payload });
      return { data: { id: "task1", ...(ops.payload as object) }, error: null };
    }
    return { data: null, error: null };
  }

  function builder(table: string) {
    const ops = {
      table,
      type: "select",
      payload: undefined as unknown,
      filters: [] as [string, string, unknown][],
    };
    const b: Record<string, unknown> = {
      select: () => b,
      insert: (p: unknown) => ((ops.type = "insert"), (ops.payload = p), b),
      update: (p: unknown) => ((ops.type = "update"), (ops.payload = p), b),
      delete: () => ((ops.type = "delete"), b),
      upsert: (p: unknown) => ((ops.type = "upsert"), (ops.payload = p), b),
      eq: (k: string, v: unknown) => (ops.filters.push(["eq", k, v]), b),
      gte: () => b,
      is: () => b,
      order: () => b,
      limit: () => b,
      single: () => Promise.resolve(resolve(ops)),
      maybeSingle: () => Promise.resolve(resolve(ops)),
      then: (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
        Promise.resolve(resolve(ops)).then(onF, onR),
    };
    return b;
  }

  return {
    supabaseAdmin: () => ({
      from: (t: string) => {
        state.fromCalls.push(t);
        return builder(t);
      },
      rpc: () => Promise.resolve({ error: null }),
    }),
  };
});

vi.mock("./meta-send", () => ({
  engineSendText: vi.fn(async () => ({ whatsapp_message_id: "m1" })),
  engineSendTemplate: vi.fn(async () => ({ whatsapp_message_id: "m1" })),
}));

import { runAutomationsForTrigger } from "./engine";

const ACCOUNT = "acct-1";

beforeEach(() => {
  h.state.owned = null;
  h.state.account = {
    plan: "trial",
    plan_status: "trial",
    plan_expires_at: null,
    module_overrides: {},
    limit_overrides: {},
  };
  h.state.ownedCustomField = null;
  h.state.automations = [];
  h.state.steps = [];
  h.state.fromCalls = [];
  h.state.updateCalls = [];
  h.state.upsertCalls = [];
  h.state.taskStatuses = [];
  h.state.member = null;
  h.state.insertCalls = [];
  h.state.logResults = [];
});

describe("runAutomationsForTrigger — tenant isolation", () => {
  it("refuses to dispatch when the contact is not in the account (GHSA-63cv-2c49-m5v3)", async () => {
    // Ownership lookup returns nothing — the contact belongs to another tenant.
    h.state.owned = null;
    // If the guard failed, this automation would run an update_contact_field step.
    h.state.automations = [automationWithUpdateStep()];
    h.state.steps = [updateStep()];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "new_message_received",
      contactId: "victim-contact-uuid",
      context: { message_text: "manual trigger" },
    });

    // Bailed at the guard: never fetched automations, never wrote a contact.
    expect(h.state.fromCalls).toContain("contacts");
    expect(h.state.fromCalls).not.toContain("automations");
    expect(h.state.updateCalls).toHaveLength(0);
  });

  it("proceeds past the guard when the contact belongs to the account", async () => {
    h.state.owned = { id: "c1" };
    h.state.automations = []; // no matching automations; just prove we got past the guard

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "new_message_received",
      contactId: "c1",
      context: {},
    });

    expect(h.state.fromCalls).toContain("automations");
  });

  it("scopes the update_contact_field write to the automation's account", async () => {
    h.state.owned = { id: "c1" };
    h.state.automations = [automationWithUpdateStep()];
    h.state.steps = [updateStep()];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "new_message_received",
      contactId: "c1",
      context: {},
    });

    expect(h.state.updateCalls).toHaveLength(1);
    const filters = h.state.updateCalls[0].filters;
    expect(filters).toContainEqual(["eq", "id", "c1"]);
    expect(filters).toContainEqual(["eq", "account_id", ACCOUNT]);
  });
});

describe("runAutomationsForTrigger — plan gate (migration 025)", () => {
  it("runs nothing when the account's plan lacks the automations module", async () => {
    h.state.owned = { id: "c1" };
    h.state.account = { plan: "basico", plan_status: "active" };
    h.state.automations = [automationWithUpdateStep()];
    h.state.steps = [updateStep()];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "new_message_received",
      contactId: "c1",
      context: {},
    });

    expect(h.state.fromCalls).toContain("accounts");
    expect(h.state.fromCalls).not.toContain("automations");
    expect(h.state.updateCalls).toHaveLength(0);
  });

  it("runs nothing when the account is suspended, even with the module on", async () => {
    h.state.owned = { id: "c1" };
    h.state.account = { plan: "empresa", plan_status: "suspended" };
    h.state.automations = [automationWithUpdateStep()];
    h.state.steps = [updateStep()];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "new_message_received",
      contactId: "c1",
      context: {},
    });

    expect(h.state.fromCalls).not.toContain("automations");
    expect(h.state.updateCalls).toHaveLength(0);
  });

  it("runs when a per-account override switches the module on", async () => {
    h.state.owned = { id: "c1" };
    h.state.account = {
      plan: "basico",
      plan_status: "active",
      module_overrides: { automations: true },
    };
    h.state.automations = [automationWithUpdateStep()];
    h.state.steps = [updateStep()];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "new_message_received",
      contactId: "c1",
      context: {},
    });

    expect(h.state.updateCalls).toHaveLength(1);
  });
});

describe("update_contact_field — custom fields", () => {
  it("upserts contact_custom_values when the field is account-owned", async () => {
    h.state.owned = { id: "c1" };
    h.state.ownedCustomField = { id: "cf1" };
    h.state.automations = [automationWithUpdateStep()];
    h.state.steps = [customStep("custom:cf1", "Premium")];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "new_message_received",
      contactId: "c1",
      context: {},
    });

    // No direct contacts column write for a custom field.
    expect(h.state.updateCalls).toHaveLength(0);
    expect(h.state.upsertCalls).toHaveLength(1);
    expect(h.state.upsertCalls[0].payload).toEqual({
      contact_id: "c1",
      custom_field_id: "cf1",
      value: "Premium",
    });
  });

  it("interpolates {{ vars.* }} into the custom value", async () => {
    h.state.owned = { id: "c1" };
    h.state.ownedCustomField = { id: "cf1" };
    h.state.automations = [automationWithUpdateStep()];
    h.state.steps = [customStep("custom:cf1", "{{ vars.source }}")];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "new_message_received",
      contactId: "c1",
      context: { vars: { source: "WhatsApp Ad" } },
    });

    expect(h.state.upsertCalls).toHaveLength(1);
    expect(
      (h.state.upsertCalls[0].payload as { value: string }).value,
    ).toBe("WhatsApp Ad");
  });

  it("refuses to write a custom field from another account", async () => {
    h.state.owned = { id: "c1" };
    h.state.ownedCustomField = null; // account-scoped lookup finds nothing
    h.state.automations = [automationWithUpdateStep()];
    h.state.steps = [customStep("custom:foreign-cf", "x")];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "new_message_received",
      contactId: "c1",
      context: {},
    });

    expect(h.state.upsertCalls).toHaveLength(0);
    expect(h.state.updateCalls).toHaveLength(0);
  });
});

describe("create_task step", () => {
  const STATUSES = [
    { id: "st-open", account_id: ACCOUNT, name: "A fazer", kind: "open", is_default: true, position: 0 },
    { id: "st-doing", account_id: ACCOUNT, name: "Em andamento", kind: "in_progress", is_default: false, position: 1 },
    { id: "st-done", account_id: ACCOUNT, name: "Concluída", kind: "done", is_default: false, position: 2 },
  ];

  it("inserts a task on the default open status, linked to the trigger's contact + conversation", async () => {
    h.state.owned = { id: "c1", name: "Maria Silva", phone: "+5511999", email: null, company: null } as never;
    h.state.taskStatuses = STATUSES;
    h.state.automations = [automationWithUpdateStep()];
    h.state.steps = [
      createTaskStep({
        title: "Atendimento: {{ contact.name }}",
        description: "Última mensagem: {{ message.text }}",
        priority: "high",
        due_in_hours: 24,
      }),
    ];

    const before = Date.now();
    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "new_message_received",
      contactId: "c1",
      context: { message_text: "quero um orçamento", conversation_id: "conv1" },
    });

    expect(h.state.insertCalls).toHaveLength(1);
    const row = h.state.insertCalls[0].payload as Record<string, unknown>;
    expect(row).toMatchObject({
      account_id: ACCOUNT,
      created_by: null,
      status_id: "st-open",
      title: "Atendimento: Maria Silva",
      description: "Última mensagem: quero um orçamento",
      priority: "high",
      assignee_user_id: null,
      contact_id: "c1",
      conversation_id: "conv1",
      deal_id: null,
    });
    const due = new Date(row.due_at as string).getTime();
    expect(due).toBeGreaterThanOrEqual(before + 24 * 3_600_000 - 1_000);
    expect(due).toBeLessThanOrEqual(Date.now() + 24 * 3_600_000 + 1_000);

    expect(h.state.logResults).toEqual([
      expect.objectContaining({ step_type: "create_task", status: "success", detail: "task created (task1)" }),
    ]);
  });

  it("defaults priority to normal, leaves due_at empty and keeps only account members as assignee", async () => {
    h.state.owned = { id: "c1" };
    h.state.taskStatuses = STATUSES;
    h.state.member = null; // assignee lookup finds no member of this account
    h.state.automations = [automationWithUpdateStep()];
    h.state.steps = [
      createTaskStep({ title: "Ligar de volta", priority: "asap", assignee_user_id: "stranger", due_in_hours: "" }),
    ];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "new_message_received",
      contactId: "c1",
      context: {},
    });

    expect(h.state.insertCalls).toHaveLength(1);
    expect(h.state.insertCalls[0].payload).toMatchObject({
      title: "Ligar de volta",
      priority: "normal",
      assignee_user_id: null,
      due_at: null,
      conversation_id: null,
    });
  });

  it("assigns to a verified account member", async () => {
    h.state.owned = { id: "c1" };
    h.state.taskStatuses = STATUSES;
    h.state.member = { user_id: "u-agent" };
    h.state.automations = [automationWithUpdateStep()];
    h.state.steps = [createTaskStep({ title: "x", assignee_user_id: "u-agent" })];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "new_message_received",
      contactId: "c1",
      context: {},
    });

    expect(h.state.insertCalls[0].payload).toMatchObject({ assignee_user_id: "u-agent" });
  });

  it("fails the step (no insert) when the account has no task statuses or no title", async () => {
    h.state.owned = { id: "c1" };
    h.state.taskStatuses = [];
    h.state.automations = [automationWithUpdateStep()];
    h.state.steps = [createTaskStep({ title: "x" })];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "new_message_received",
      contactId: "c1",
      context: {},
    });
    expect(h.state.insertCalls).toHaveLength(0);
    expect(h.state.logResults).toEqual([
      expect.objectContaining({ step_type: "create_task", status: "failed", detail: "account has no task statuses" }),
    ]);

    h.state.logResults = [];
    h.state.taskStatuses = STATUSES;
    h.state.steps = [createTaskStep({ title: "  " })];
    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "new_message_received",
      contactId: "c1",
      context: {},
    });
    expect(h.state.insertCalls).toHaveLength(0);
    expect(h.state.logResults[0]).toMatchObject({ status: "failed", detail: "create_task needs a title" });
  });

  it("refuses when the account's plan lacks the tasks module", async () => {
    h.state.owned = { id: "c1" };
    h.state.taskStatuses = STATUSES;
    h.state.account = {
      plan: "trial",
      plan_status: "trial",
      plan_expires_at: null,
      module_overrides: { tasks: false },
      limit_overrides: {},
    };
    h.state.automations = [automationWithUpdateStep()];
    h.state.steps = [createTaskStep({ title: "x" })];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "new_message_received",
      contactId: "c1",
      context: {},
    });
    expect(h.state.insertCalls).toHaveLength(0);
    expect(h.state.logResults[0]).toMatchObject({
      status: "failed",
      detail: "tasks module is not enabled for this account",
    });
  });
});

describe("interpolation — {{ contact.* }}", () => {
  it("resolves contact name / email in update_contact_field values", async () => {
    h.state.owned = { id: "c1", name: "João", phone: "+55 11 9", email: "j@x.io", company: null } as never;
    h.state.ownedCustomField = { id: "cf1" };
    h.state.automations = [automationWithUpdateStep()];
    h.state.steps = [customStep("custom:cf1", "{{ contact.name }} <{{ contact.email }}> {{ contact.company }}")];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "new_message_received",
      contactId: "c1",
      context: {},
    });

    expect((h.state.upsertCalls[0].payload as { value: string }).value).toBe("João <j@x.io> ");
  });
});

function createTaskStep(step_config: Record<string, unknown>) {
  return {
    id: "s1",
    automation_id: "a1",
    step_type: "create_task",
    position: 0,
    parent_step_id: null,
    step_config,
  };
}

function automationWithUpdateStep() {
  return {
    id: "a1",
    account_id: ACCOUNT,
    user_id: "u1",
    trigger_type: "new_message_received",
    trigger_config: {},
    is_active: true,
  };
}

function updateStep() {
  return {
    id: "s1",
    automation_id: "a1",
    step_type: "update_contact_field",
    position: 0,
    parent_step_id: null,
    step_config: { field: "company", value: "pwned-by-automation" },
  };
}

function customStep(field: string, value: string) {
  return {
    id: "s1",
    automation_id: "a1",
    step_type: "update_contact_field",
    position: 0,
    parent_step_id: null,
    step_config: { field, value },
  };
}

// ------------------------------------------------------------
// lead_captured trigger (migration 029) — optional per-source filter.
// ------------------------------------------------------------
describe("lead_captured trigger — source filter", () => {
  const SOURCE = "0b7f2a6e-4b1c-4d2e-9f3a-8c1d2e3f4a5b";

  function leadAutomation(source_id?: string) {
    return {
      ...automationWithUpdateStep(),
      trigger_type: "lead_captured",
      trigger_config: source_id ? { source_id } : {},
    };
  }

  async function fire(sourceId: string) {
    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "lead_captured",
      contactId: "c1",
      context: { vars: { source_id: sourceId, source_name: "Landing" } },
    });
  }

  beforeEach(() => {
    h.state.owned = { id: "c1" };
    h.state.steps = [updateStep()];
  });

  it("runs for any source when the config has no source_id", async () => {
    h.state.automations = [leadAutomation()];
    await fire("some-other-source");
    expect(h.state.updateCalls).toHaveLength(1);
  });

  it("runs only when the context names the configured source", async () => {
    h.state.automations = [leadAutomation(SOURCE)];
    await fire("some-other-source");
    expect(h.state.updateCalls).toHaveLength(0);
    await fire(SOURCE);
    expect(h.state.updateCalls).toHaveLength(1);
  });
});

describe("opt-out (migration 030) — send steps are skipped", () => {
  const sendStep = (id: string, position: number) => ({
    id,
    automation_id: "a1",
    step_type: "send_message",
    position,
    parent_step_id: null,
    step_config: { text: "Oi {{contact.name}}" },
  });
  const templateStep = (id: string, position: number) => ({
    id,
    automation_id: "a1",
    step_type: "send_template",
    position,
    parent_step_id: null,
    step_config: { template_name: "hello" },
  });

  it("skips send_message / send_template when the contact row is opted out, but still runs other steps", async () => {
    const { engineSendText, engineSendTemplate } = await import("./meta-send");
    (engineSendText as unknown as ReturnType<typeof vi.fn>).mockClear();
    (engineSendTemplate as unknown as ReturnType<typeof vi.fn>).mockClear();

    h.state.owned = { id: "c1", opted_out_at: "2026-09-13T10:00:00.000Z" } as { id: string };
    h.state.automations = [automationWithUpdateStep()];
    h.state.steps = [sendStep("s1", 0), templateStep("s2", 1), { ...updateStep(), id: "s3", position: 2 }];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "new_message_received",
      contactId: "c1",
      context: { conversation_id: "conv-1" },
    });

    expect(engineSendText).not.toHaveBeenCalled();
    expect(engineSendTemplate).not.toHaveBeenCalled();
    expect(h.state.logResults).toEqual([
      expect.objectContaining({ step_id: "s1", status: "skipped", detail: "contato descadastrado" }),
      expect.objectContaining({ step_id: "s2", status: "skipped", detail: "contato descadastrado" }),
      expect.objectContaining({ step_id: "s3", status: "success" }),
    ]);
    // The non-send step still wrote to the contact.
    expect(h.state.updateCalls).toHaveLength(1);
  });

  it("honours context.vars.opted_out from the inbound pipeline without a contact read", async () => {
    const { engineSendText } = await import("./meta-send");
    (engineSendText as unknown as ReturnType<typeof vi.fn>).mockClear();

    h.state.owned = { id: "c1" };
    h.state.automations = [automationWithUpdateStep()];
    h.state.steps = [sendStep("s1", 0)];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "new_message_received",
      contactId: "c1",
      context: { conversation_id: "conv-1", vars: { opted_out: true } },
    });

    expect(engineSendText).not.toHaveBeenCalled();
    expect(h.state.logResults[0]).toMatchObject({ status: "skipped", detail: "contato descadastrado" });
  });

  it("sends normally when the contact is not opted out", async () => {
    const { engineSendText } = await import("./meta-send");
    (engineSendText as unknown as ReturnType<typeof vi.fn>).mockClear();

    h.state.owned = { id: "c1" };
    h.state.automations = [automationWithUpdateStep()];
    h.state.steps = [sendStep("s1", 0)];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "new_message_received",
      contactId: "c1",
      context: { conversation_id: "conv-1" },
    });

    expect(engineSendText).toHaveBeenCalledTimes(1);
    expect(h.state.logResults[0]).toMatchObject({ step_id: "s1", status: "success" });
  });
});

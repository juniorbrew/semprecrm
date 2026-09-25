import { describe, expect, it } from "vitest";
import {
  validateStepsForActivation,
  validateTriggerForActivation,
  validateRunFrequency,
} from "./validate";

describe("validateStepsForActivation", () => {
  it("rejects empty or missing step lists", () => {
    expect(validateStepsForActivation([])).toEqual([
      { path: "steps", message: "active automations need at least one step" },
    ]);
    expect(
      validateStepsForActivation(undefined as unknown as never[]),
    ).toEqual([
      { path: "steps", message: "active automations need at least one step" },
    ]);
  });

  it("passes a fully-populated step set", () => {
    const issues = validateStepsForActivation([
      { step_type: "send_message", step_config: { text: "hi" } },
      {
        step_type: "wait",
        step_config: { amount: 5, unit: "minutes" },
      },
      { step_type: "add_tag", step_config: { tag_id: "tag-uuid" } },
      { step_type: "close_conversation", step_config: {} },
    ]);
    expect(issues).toEqual([]);
  });

  it("flags every required field that is missing", () => {
    const issues = validateStepsForActivation([
      { step_type: "send_message", step_config: { text: "  " } },
      { step_type: "send_template", step_config: {} },
      { step_type: "add_tag", step_config: { tag_id: "" } },
    ]);
    expect(issues.map((i) => i.path)).toEqual([
      "steps[0].text",
      "steps[1].template_name",
      "steps[2].tag_id",
    ]);
  });

  it("checks wait amount and unit boundaries", () => {
    const issues = validateStepsForActivation([
      { step_type: "wait", step_config: { amount: 0, unit: "minutes" } },
      { step_type: "wait", step_config: { amount: 5, unit: "seconds" } },
      { step_type: "wait", step_config: { amount: -1, unit: "hours" } },
      {
        step_type: "wait",
        step_config: { amount: Number.POSITIVE_INFINITY, unit: "days" },
      },
    ]);
    expect(issues.map((i) => i.path)).toEqual([
      "steps[0].amount",
      "steps[1].unit",
      "steps[2].amount",
      "steps[3].amount",
    ]);
  });

  it("validates webhook URLs", () => {
    const good = validateStepsForActivation([
      {
        step_type: "send_webhook",
        step_config: { url: "https://hooks.example.com/in" },
      },
    ]);
    expect(good).toEqual([]);

    const noUrl = validateStepsForActivation([
      { step_type: "send_webhook", step_config: {} },
    ]);
    expect(noUrl.map((i) => i.message)).toContain("webhook URL is required");

    const wrongProtocol = validateStepsForActivation([
      {
        step_type: "send_webhook",
        step_config: { url: "ftp://files.example.com" },
      },
    ]);
    expect(wrongProtocol.map((i) => i.message)).toContain(
      "webhook URL must use http or https",
    );

    const garbage = validateStepsForActivation([
      { step_type: "send_webhook", step_config: { url: "not a url" } },
    ]);
    expect(garbage.map((i) => i.message)).toContain(
      "webhook URL is not a valid URL",
    );
  });

  it("validates assign_conversation only when mode is 'specific'", () => {
    const roundRobinNoAgent = validateStepsForActivation([
      {
        step_type: "assign_conversation",
        step_config: { mode: "round_robin" },
      },
    ]);
    expect(roundRobinNoAgent).toEqual([]);

    const specificMissingAgent = validateStepsForActivation([
      { step_type: "assign_conversation", step_config: { mode: "specific" } },
    ]);
    expect(specificMissingAgent.map((i) => i.path)).toEqual([
      "steps[0].agent_id",
    ]);
  });

  it("flags create_deal when required fields are missing", () => {
    const issues = validateStepsForActivation([
      { step_type: "create_deal", step_config: {} },
    ]);
    expect(issues.map((i) => i.path).sort()).toEqual([
      "steps[0].pipeline_id",
      "steps[0].stage_id",
      "steps[0].title",
    ]);
  });

  it("flags update_contact_field when field or value is missing", () => {
    const issues = validateStepsForActivation([
      { step_type: "update_contact_field", step_config: { field: "name" } },
      {
        step_type: "update_contact_field",
        step_config: { field: "", value: "x" },
      },
    ]);
    expect(issues.map((i) => i.path)).toEqual([
      "steps[0].value",
      "steps[1].field",
    ]);
  });

  it("recursively walks condition branches with stable dot-paths", () => {
    const issues = validateStepsForActivation([
      {
        step_type: "condition",
        step_config: { subject: "tag_presence", operand: "vip" },
        branches: {
          yes: [{ step_type: "add_tag", step_config: { tag_id: "" } }],
          no: [
            {
              step_type: "send_message",
              step_config: { text: "" },
            },
          ],
        },
      },
    ]);
    expect(issues.map((i) => i.path)).toEqual([
      "steps[0].yes.steps[0].tag_id",
      "steps[0].no.steps[0].text",
    ]);
  });

  it("reports an issue for unknown step types", () => {
    const issues = validateStepsForActivation([
      { step_type: "do_a_barrel_roll", step_config: {} },
    ]);
    expect(issues).toEqual([
      { path: "steps[0]", message: "unknown step type: do_a_barrel_roll" },
    ]);
  });

  it("flags a missing condition subject", () => {
    const issues = validateStepsForActivation([
      { step_type: "condition", step_config: {} },
    ]);
    expect(issues.map((i) => i.path)).toEqual(["steps[0].subject"]);
  });

  it("asks each condition subject for what it actually uses", () => {
    const paths = (step_config: Record<string, unknown>) =>
      validateStepsForActivation([{ step_type: "condition", step_config }]).map((i) => i.path);
    expect(paths({ subject: "tag_presence" })).toEqual(["steps[0].operand"]);
    expect(paths({ subject: "tag_absence" })).toEqual(["steps[0].operand"]);
    expect(paths({ subject: "tag_absence", operand: "tag-uuid" })).toEqual([]);
    expect(paths({ subject: "message_content" })).toEqual(["steps[0].value"]);
    expect(paths({ subject: "message_content", value: "preço" })).toEqual([]);
    expect(paths({ subject: "business_hours" })).toEqual([]);
    expect(paths({ subject: "time_of_day", operand: "6pm" })).toEqual(["steps[0].operand"]);
    expect(paths({ subject: "time_of_day", operand: "18:00-09:00" })).toEqual([]);
    expect(paths({ subject: "moon_phase", operand: "full" })).toEqual(["steps[0].subject"]);
  });

  it("checks cancel_on_reply on waits", () => {
    expect(
      validateStepsForActivation([
        { step_type: "wait", step_config: { amount: 1, unit: "days", cancel_on_reply: true } },
      ]),
    ).toEqual([]);
    expect(
      validateStepsForActivation([
        { step_type: "wait", step_config: { amount: 1, unit: "days", cancel_on_reply: "yes" } },
      ]).map((i) => i.path),
    ).toEqual(["steps[0].cancel_on_reply"]);
  });

  describe("create_task", () => {
    it("accepts a title-only step and a fully configured one", () => {
      expect(
        validateStepsForActivation([
          { step_type: "create_task", step_config: { title: "Follow up" } },
          {
            step_type: "create_task",
            step_config: {
              title: "Call {{ contact.name }}",
              description: "Ask about the quote",
              priority: "high",
              assignee_user_id: "user-uuid",
              due_in_hours: 24,
            },
          },
          // The builder stores an emptied number input as "" — that
          // means "no due date", not an error.
          {
            step_type: "create_task",
            step_config: { title: "x", priority: "", due_in_hours: "" },
          },
        ]),
      ).toEqual([]);
    });

    it("requires a non-blank title", () => {
      const issues = validateStepsForActivation([
        { step_type: "create_task", step_config: { title: "   " } },
        { step_type: "create_task", step_config: {} },
      ]);
      expect(issues).toEqual([
        { path: "steps[0].title", message: "task title is required" },
        { path: "steps[1].title", message: "task title is required" },
      ]);
    });

    it("rejects unknown priorities and negative / non-numeric due hours", () => {
      const issues = validateStepsForActivation([
        { step_type: "create_task", step_config: { title: "x", priority: "asap" } },
        { step_type: "create_task", step_config: { title: "x", due_in_hours: -2 } },
        { step_type: "create_task", step_config: { title: "x", due_in_hours: "soon" } },
      ]);
      expect(issues.map((i) => i.path)).toEqual([
        "steps[0].priority",
        "steps[1].due_in_hours",
        "steps[2].due_in_hours",
      ]);
    });
  });
});

describe("validateTriggerForActivation", () => {
  it("accepts a valid keyword_match config", () => {
    expect(
      validateTriggerForActivation("keyword_match", {
        keywords: ["hello", "hi"],
        match_type: "exact",
      }),
    ).toEqual([]);
  });

  it("rejects keyword_match with empty keyword array", () => {
    const issues = validateTriggerForActivation("keyword_match", {
      keywords: [],
      match_type: "exact",
    });
    expect(issues.map((i) => i.path)).toContain("trigger.keywords");
  });

  it("rejects keyword_match with whitespace-only entries", () => {
    const issues = validateTriggerForActivation("keyword_match", {
      keywords: ["hi", "   "],
      match_type: "contains",
    });
    expect(issues.map((i) => i.message)).toContain(
      "keywords cannot be empty strings",
    );
  });

  it("rejects keyword_match with an unknown match_type", () => {
    const issues = validateTriggerForActivation("keyword_match", {
      keywords: ["hi"],
      match_type: "fuzzy",
    });
    expect(issues.map((i) => i.path)).toContain("trigger.match_type");
  });

  it("refuses to activate the never-wired time_based trigger", () => {
    expect(
      validateTriggerForActivation("time_based", { schedule: "0 9 * * *" }).map((i) => i.path),
    ).toEqual(["trigger.type"]);
  });

  it("accepts the reopened / resolved triggers without config", () => {
    expect(validateTriggerForActivation("conversation_reopened", {})).toEqual([]);
    expect(validateTriggerForActivation("conversation_resolved", {})).toEqual([]);
  });

  it("validates run frequency and the cooldown interval", () => {
    expect(validateRunFrequency(undefined, undefined)).toEqual([]);
    expect(validateRunFrequency("once_per_contact", null)).toEqual([]);
    expect(validateRunFrequency("sometimes", null).map((i) => i.path)).toEqual(["run_frequency"]);
    expect(validateRunFrequency("cooldown", 12)).toEqual([]);
    expect(validateRunFrequency("cooldown", "12")).toEqual([]);
    expect(validateRunFrequency("cooldown", 0).map((i) => i.path)).toEqual(["cooldown_hours"]);
    expect(validateRunFrequency("cooldown", 1000).map((i) => i.path)).toEqual(["cooldown_hours"]);
  });

  it("requires tag_id on tag_added triggers", () => {
    expect(validateTriggerForActivation("tag_added", {})).toEqual([
      { path: "trigger.tag_id", message: "tag is required" },
    ]);
    expect(
      validateTriggerForActivation("tag_added", { tag_id: "tag-uuid" }),
    ).toEqual([]);
  });

  it("lead_captured: source_id is optional but must be a uuid when set", () => {
    expect(validateTriggerForActivation("lead_captured", {})).toEqual([]);
    expect(validateTriggerForActivation("lead_captured", { source_id: "" })).toEqual([]);
    expect(
      validateTriggerForActivation("lead_captured", {
        source_id: "0b7f2a6e-4b1c-4d2e-9f3a-8c1d2e3f4a5b",
      }),
    ).toEqual([]);
    expect(
      validateTriggerForActivation("lead_captured", { source_id: "not-a-uuid" }).map((i) => i.path),
    ).toEqual(["trigger.source_id"]);
    expect(
      validateTriggerForActivation("lead_captured", { source_id: 42 }).map((i) => i.path),
    ).toEqual(["trigger.source_id"]);
  });

  it("conversation_inactive: hours 0.05–720, known last_from, non-empty statuses", () => {
    expect(
      validateTriggerForActivation("conversation_inactive", {
        hours: 24,
        last_from: "agent",
        statuses: ["open", "pending"],
      }),
    ).toEqual([]);
    expect(
      validateTriggerForActivation("conversation_inactive", {
        hours: 0.05,
        last_from: "any",
        statuses: ["open"],
      }),
    ).toEqual([]);
    expect(
      validateTriggerForActivation("conversation_inactive", {
        hours: "12",
        last_from: "customer",
        statuses: ["pending"],
      }),
    ).toEqual([]);

    const paths = (cfg: unknown) =>
      validateTriggerForActivation("conversation_inactive", cfg).map((i) => i.path);
    expect(paths({ hours: 0.01, last_from: "agent", statuses: ["open"] })).toEqual([
      "trigger.hours",
    ]);
    expect(paths({ hours: 721, last_from: "agent", statuses: ["open"] })).toEqual([
      "trigger.hours",
    ]);
    expect(paths({ hours: 2, last_from: "bot", statuses: ["open"] })).toEqual([
      "trigger.last_from",
    ]);
    expect(paths({ hours: 2, last_from: "agent", statuses: [] })).toEqual(["trigger.statuses"]);
    expect(paths({ hours: 2, last_from: "agent", statuses: ["closed"] })).toEqual([
      "trigger.statuses",
    ]);
    expect(paths({})).toEqual(["trigger.hours", "trigger.last_from", "trigger.statuses"]);
  });

  it("does not flag unknown trigger types (handled elsewhere)", () => {
    expect(validateTriggerForActivation("some_future_trigger", {})).toEqual([]);
  });
});

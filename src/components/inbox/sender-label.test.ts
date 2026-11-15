import { describe, expect, it } from "vitest";

import { agentNameHeader, type SenderLabel } from "./sender-label";

const you: SenderLabel = { kind: "you", text: "You", translate: true };
const ana: SenderLabel = { kind: "agent", text: "Ana Souza", translate: false };
const unknown: SenderLabel = { kind: "agent", text: "Agent", translate: true };
const msg = (content_type: string, content_text: string | null = "oi") =>
  ({ content_type, content_text }) as Parameters<typeof agentNameHeader>[0];

describe("agentNameHeader", () => {
  it("shows my own name on my replies and the teammate's on theirs", () => {
    expect(agentNameHeader(msg("text"), you, "Bruno Lima")).toBe("Bruno Lima");
    expect(agentNameHeader(msg("text"), ana, "Bruno Lima")).toBe("Ana Souza");
  });

  it("covers captions, not bare media, audio or templates", () => {
    expect(agentNameHeader(msg("image", "legenda"), you, "Bruno")).toBe("Bruno");
    expect(agentNameHeader(msg("image", null), you, "Bruno")).toBeNull();
    expect(agentNameHeader(msg("audio"), you, "Bruno")).toBeNull();
    expect(agentNameHeader(msg("template"), you, "Bruno")).toBeNull();
  });

  it("never for automations, the AI, the phone, or an unknown sender", () => {
    for (const kind of ["automation", "ai", "bot", "phone", "system", "survey"] as const) {
      expect(agentNameHeader(msg("text"), { kind, text: "x", translate: true }, "Bruno")).toBeNull();
    }
    expect(agentNameHeader(msg("text"), unknown, "Bruno")).toBeNull();
    expect(agentNameHeader(msg("text"), you, "")).toBeNull();
    expect(agentNameHeader(msg("text"), null, "Bruno")).toBeNull();
  });
});

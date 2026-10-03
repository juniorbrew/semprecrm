// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import {
  FLOWS_COPY,
  FlowListRow,
  flowMetaLine,
  flowTriggerSummary,
  readFlowsDensity,
  writeFlowsDensity,
  type FlowRow,
} from "./flow-list-row";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

const flow = (over: Partial<FlowRow> = {}): FlowRow => ({
  id: "f1",
  name: "Menu de boas-vindas",
  description: "Primeiro atendimento",
  status: "active",
  trigger_type: "keyword",
  trigger_config: { keywords: ["oi", "menu"] },
  execution_count: 2,
  last_executed_at: null,
  created_at: "2026-10-01T10:00:00Z",
  updated_at: "2026-10-01T10:00:00Z",
  ...over,
});

const pt = FLOWS_COPY["pt-BR"];

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("flowTriggerSummary", () => {
  it("lists keywords, or says none are set", () => {
    expect(flowTriggerSummary(flow(), pt)).toBe("Palavras-chave: oi, menu");
    expect(flowTriggerSummary(flow({ trigger_config: { keywords: [] } }), pt)).toBe(
      "Palavra-chave (nenhuma definida)",
    );
  });

  it("names the other trigger types", () => {
    expect(flowTriggerSummary(flow({ trigger_type: "first_inbound_message" }), pt)).toBe(
      "Primeira mensagem do contato",
    );
    expect(flowTriggerSummary(flow({ trigger_type: "manual" }), FLOWS_COPY["en-US"])).toBe("Manual start");
  });
});

describe("flowMetaLine", () => {
  it("joins trigger, runs and last run", () => {
    expect(flowMetaLine(flow(), "pt-BR", pt)).toBe("Palavras-chave: oi, menu · 2 execuções · última nunca");
  });
});

describe("FlowListRow", () => {
  it("links to the editor and shows status as dot + text", () => {
    render(
      <ul>
        <FlowListRow flow={flow({ status: "draft" })} language="pt-BR" copy={pt} compact={false} onDelete={() => {}} />
      </ul>,
    );
    expect(screen.getByText("Rascunho")).toBeTruthy();
    const link = screen.getByText("Menu de boas-vindas").closest("a");
    expect(link?.getAttribute("href")).toBe("/flows/f1");
    expect(screen.getByText("Primeiro atendimento")).toBeTruthy();
  });

  it("hides the description when compact", () => {
    render(
      <ul>
        <FlowListRow flow={flow()} language="pt-BR" copy={pt} compact onDelete={() => {}} />
      </ul>,
    );
    expect(screen.queryByText("Primeiro atendimento")).toBeNull();
  });
});

describe("density persistence", () => {
  it("round-trips per user", () => {
    expect(readFlowsDensity("u1")).toBe("comfortable");
    writeFlowsDensity("u1", "compact");
    expect(readFlowsDensity("u1")).toBe("compact");
    expect(localStorage.getItem("sempre:flows:density:u1")).toBe("compact");
  });
});

// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: { id: "u1" }, accountRole: "agent" }) }));
vi.mock("@/hooks/use-can", () => ({ useCan: () => true }));
vi.mock("@/hooks/use-language", () => ({ useLanguage: () => ({ language: "pt-BR", t: (s: string) => s }) }));

import { ScheduledOverview, scheduledCounts } from "./scheduled-overview";

vi.setConfig({ testTimeout: 30_000 });

const NOW = new Date(2026, 9, 20, 10, 0);
const row = (over: Record<string, unknown>) => ({
  id: "s1",
  conversation_id: "c1",
  created_by: "u1",
  content_text: "Oi",
  scheduled_for: new Date(2026, 9, 21, 8, 0).toISOString(),
  status: "pending",
  error_code: null,
  error_text: null,
  contact_name: "Maria",
  ...over,
});

const fetchMock = vi.fn();
let listed: unknown[] = [];

beforeEach(() => {
  listed = [];
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (_url: string, init?: RequestInit) =>
    (init?.method ?? "GET") === "GET" ? Response.json({ items: listed }) : Response.json({ success: true }),
  );
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("scheduledCounts", () => {
  it("counts open and failed", () => {
    expect(scheduledCounts([{ status: "pending" }, { status: "failed" }, { status: "sending" }])).toEqual({ open: 3, failed: 1 });
  });
});

describe("ScheduledOverview", () => {
  it("renders nothing while there is nothing scheduled", async () => {
    render(<ScheduledOverview onOpenConversation={vi.fn()} now={() => NOW} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(screen.queryByTestId("scheduled-overview-button")).toBeNull();
  });

  it("shows the count and a red badge only when something failed", async () => {
    listed = [row({}), row({ id: "s2", status: "failed", error_text: "Falhou" })];
    render(<ScheduledOverview onOpenConversation={vi.fn()} now={() => NOW} />);
    expect((await screen.findByTestId("scheduled-failed-badge")).textContent).toBe("1");
    cleanup();
    listed = [row({})];
    render(<ScheduledOverview onOpenConversation={vi.fn()} now={() => NOW} />);
    await screen.findByTestId("scheduled-overview-button");
    expect(screen.queryByTestId("scheduled-failed-badge")).toBeNull();
  });

  it("lists contact, time and status, filters to mine, and opens the conversation", async () => {
    listed = [
      row({}),
      row({ id: "s2", created_by: "u2", contact_name: "João", conversation_id: "c2" }),
      row({ id: "s3", status: "failed", error_text: "Janela encerrada", contact_name: "Ana", conversation_id: "c3" }),
    ];
    const open = vi.fn();
    render(<ScheduledOverview onOpenConversation={open} now={() => NOW} />);
    fireEvent.click(await screen.findByTestId("scheduled-overview-button"));
    expect(await screen.findByText("Maria")).toBeTruthy();
    expect(screen.getByText("João")).toBeTruthy();
    expect(screen.getByText("Janela encerrada")).toBeTruthy();
    expect(screen.getAllByText("amanhã às 08:00").length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("tab", { name: "Minhas" }));
    expect(screen.queryByText("João")).toBeNull();

    fireEvent.click(screen.getAllByText("Abrir conversa")[0]);
    expect(open).toHaveBeenCalledWith("c1");
  });

  it("retry on a failed row posts to the send endpoint", async () => {
    listed = [row({ status: "failed", error_text: "x" })];
    render(<ScheduledOverview onOpenConversation={vi.fn()} now={() => NOW} />);
    fireEvent.click(await screen.findByTestId("scheduled-overview-button"));
    fireEvent.click(await screen.findByText("Tentar de novo"));
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([u, i]) => String(u).endsWith("/s1/send") && i?.method === "POST")).toBe(true),
    );
  });
});

// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

import { ScheduledMessagesPanel } from "./scheduled-messages-panel";

vi.setConfig({ testTimeout: 30_000 });

const NOW = new Date(2026, 9, 20, 10, 0);
const item = (over: Record<string, unknown> = {}) => ({
  id: "s1",
  created_by: "u1",
  content_text: "Seu boleto vence amanhã.",
  scheduled_for: new Date(2026, 9, 21, 8, 0).toISOString(),
  status: "pending",
  error_text: null,
  ...over,
});

const fetchMock = vi.fn();
let listed: unknown[] = [];
let windowEnds: string | null = null;

beforeEach(() => {
  listed = [item()];
  windowEnds = null;
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (method === "GET") return Response.json({ items: listed, window_ends_at: windowEnds });
    if (method === "DELETE") return Response.json({ content_text: "Seu boleto vence amanhã." });
    return Response.json({ success: true });
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function setup(canAct = true, onRestoreText = vi.fn()) {
  render(
    <ScheduledMessagesPanel
      conversationId="c1"
      language="pt-BR"
      canAct={canAct}
      profiles={[{ user_id: "u1", full_name: "Ana" }]}
      refreshKey={0}
      onRestoreText={onRestoreText}
      now={() => NOW}
    />,
  );
  return onRestoreText;
}

describe("ScheduledMessagesPanel", () => {
  it("renders nothing without scheduled messages", async () => {
    listed = [];
    setup();
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(screen.queryByTestId("scheduled-panel")).toBeNull();
  });

  it("lists text, local time and author", async () => {
    setup();
    expect(await screen.findByText("Seu boleto vence amanhã.")).toBeTruthy();
    expect(screen.getByText("Envia amanhã às 08:00")).toBeTruthy();
    expect(screen.getByText("por Ana")).toBeTruthy();
    expect(screen.getByText("1 mensagem agendada")).toBeTruthy();
  });

  it("cancel deletes it and hands the text back to the composer", async () => {
    const onRestore = setup();
    fireEvent.click(await screen.findByText("Cancelar envio"));
    await waitFor(() => expect(onRestore).toHaveBeenCalledWith("Seu boleto vence amanhã."));
    expect(fetchMock.mock.calls.some(([u, i]) => String(u).endsWith("/s1") && i?.method === "DELETE")).toBe(true);
  });

  it("send now posts to the send endpoint", async () => {
    setup();
    fireEvent.click(await screen.findByText("Enviar agora"));
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([u, i]) => String(u).endsWith("/s1/send") && i?.method === "POST")).toBe(true),
    );
  });

  it("a failed message shows the reason and offers retry", async () => {
    listed = [item({ status: "failed", error_text: "A janela de 24 h do WhatsApp estava encerrada." })];
    setup();
    expect((await screen.findByRole("alert")).textContent).toContain("janela de 24 h");
    expect(screen.getByText("Não enviada")).toBeTruthy();
    expect(screen.getByText("Tentar de novo")).toBeTruthy();
  });

  it("warns when the scheduled time is past the 24 h window", async () => {
    windowEnds = new Date(2026, 9, 20, 20, 0).toISOString();
    setup();
    expect(await screen.findByText("Fora da janela de 24 h nesse horário")).toBeTruthy();
  });

  it("viewers see the list but no actions", async () => {
    setup(false);
    await screen.findByText("Seu boleto vence amanhã.");
    expect(screen.queryByText("Cancelar envio")).toBeNull();
    expect(screen.queryByText("Enviar agora")).toBeNull();
  });

  it("editing validates the new time before calling the server", async () => {
    setup();
    fireEvent.click(await screen.findByText("Editar"));
    fireEvent.change(screen.getByLabelText("Escolher data e hora"), { target: { value: "2026-10-19T09:00" } });
    fireEvent.click(screen.getByText("Salvar"));
    expect((await screen.findByRole("alert")).textContent).toContain("pelo menos 1 minuto");
    expect(fetchMock.mock.calls.some(([, i]) => i?.method === "PATCH")).toBe(false);
  });
});

// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ScheduleMessageMenu } from "./schedule-message-menu";

vi.setConfig({ testTimeout: 30_000 });
afterEach(cleanup);

// Tuesday 20 Oct 2026, 10:00 local — the clock is injected, never read.
const NOW = new Date(2026, 9, 20, 10, 0);

function setup(onSchedule = vi.fn<(at: Date) => Promise<void>>(async () => {}), disabled = false) {
  render(
    <ScheduleMessageMenu language="pt-BR" disabled={disabled} onSchedule={onSchedule} now={() => NOW} />,
  );
  return onSchedule;
}

describe("ScheduleMessageMenu", () => {
  it("is disabled when there is nothing to schedule", () => {
    setup(undefined, true);
    expect((screen.getByTestId("schedule-trigger") as HTMLButtonElement).disabled).toBe(true);
  });

  it("schedules a preset in local time", async () => {
    const onSchedule = setup();
    fireEvent.click(screen.getByTestId("schedule-trigger"));
    fireEvent.click(await screen.findByText("Amanhã às 8h"));
    await waitFor(() => expect(onSchedule).toHaveBeenCalledTimes(1));
    expect(onSchedule.mock.calls[0][0]).toEqual(new Date(2026, 9, 21, 8, 0));
  });

  it("rejects a custom time in the past with a message and does not call the server", async () => {
    const onSchedule = setup();
    fireEvent.click(screen.getByTestId("schedule-trigger"));
    const input = (await screen.findByLabelText("Escolher data e hora")) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "2026-10-20T09:00" } });
    fireEvent.click(screen.getByText("Agendar envio"));
    expect((await screen.findByRole("alert")).textContent).toContain("pelo menos 1 minuto");
    expect(onSchedule).not.toHaveBeenCalled();
  });

  it("accepts a valid custom time", async () => {
    const onSchedule = setup();
    fireEvent.click(screen.getByTestId("schedule-trigger"));
    const input = (await screen.findByLabelText("Escolher data e hora")) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "2026-10-23T15:30" } });
    fireEvent.click(screen.getByText("Agendar envio"));
    await waitFor(() => expect(onSchedule).toHaveBeenCalledTimes(1));
    expect(onSchedule.mock.calls[0][0]).toEqual(new Date(2026, 9, 23, 15, 30));
  });

  it("shows the server's refusal inline and keeps the menu open", async () => {
    const onSchedule = setup(vi.fn<(at: Date) => Promise<void>>(async () => Promise.reject(new Error("Limite de 100 mensagens agendadas atingido."))));
    fireEvent.click(screen.getByTestId("schedule-trigger"));
    fireEvent.click(await screen.findByText("Amanhã às 14h"));
    expect((await screen.findByRole("alert")).textContent).toContain("Limite de 100");
    expect(onSchedule).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Agendar envio")).toBeTruthy();
  });
});

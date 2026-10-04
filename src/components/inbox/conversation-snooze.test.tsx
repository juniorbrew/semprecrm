// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const updates: unknown[] = [];
let result: { data: unknown; error: { code: string; message: string } | null } = { data: null, error: null };
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    from: () => ({
      update: (patch: unknown) => ({
        eq: () => ({
          select: () => ({
            maybeSingle: async () => {
              updates.push(patch);
              return result;
            },
          }),
        }),
      }),
    }),
  }),
}));
const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock("sonner", () => ({
  toast: { success: (...a: unknown[]) => toastSuccess(...a), error: (...a: unknown[]) => toastError(...a) },
}));

import type { Conversation } from "@/types";
import { dispatchInboxShortcut } from "@/lib/inbox/shortcuts";
import { INBOX_SNOOZED_EVENT } from "@/lib/inbox/snooze";
import { ConversationSnooze } from "./conversation-snooze";

const conv = (over: Partial<Conversation> = {}) =>
  ({ id: "c1", status: "open", archived_at: null, snoozed_until: null, snooze_note: null, ...over }) as Conversation;

const snoozedRow = (until: string) => ({
  snoozed_until: until,
  snoozed_at: "now",
  snoozed_by: "me",
  snooze_note: "boleto",
  snooze_woke_at: null,
  unread_count: 0,
});

// First render pays the jsdom + Base UI import cost.
vi.setConfig({ testTimeout: 30_000 });

beforeEach(() => {
  updates.length = 0;
  result = { data: null, error: null };
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const openPopover = async () => {
  fireEvent.click(screen.getByTestId("snooze-trigger"));
  await waitFor(() => expect(screen.getByText("Adiar conversa")).toBeTruthy());
};

describe("ConversationSnooze", () => {
  it("a preset writes snoozed_until + note, patches, offers Desfazer and tells the list to move on", async () => {
    const onPatch = vi.fn();
    const moved: string[] = [];
    const onMoved = (e: Event) => moved.push((e as CustomEvent<string>).detail);
    window.addEventListener(INBOX_SNOOZED_EVENT, onMoved);
    render(<ConversationSnooze conversation={conv()} contactName="Ana" disabled={false} onPatch={onPatch} />);
    await openPopover();
    expect(screen.getByText("Daqui a 1 hora")).toBeTruthy();
    expect(screen.getByText("Amanhã às 9h")).toBeTruthy();
    expect(screen.getByText("Próxima segunda às 9h")).toBeTruthy();
    // One filled button: "Adiar".
    expect(screen.getByRole("button", { name: "Adiar" })).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Motivo (opcional)"), { target: { value: " boleto " } });
    result = { data: snoozedRow("T"), error: null };
    fireEvent.click(screen.getByText("Amanhã às 9h"));
    await waitFor(() => expect(onPatch).toHaveBeenCalledWith("c1", snoozedRow("T")));
    window.removeEventListener(INBOX_SNOOZED_EVENT, onMoved);

    const patch = updates[0] as { snoozed_until: string; snooze_note: string };
    expect(patch.snooze_note).toBe("boleto");
    const when = new Date(patch.snoozed_until);
    expect([when.getHours(), when.getMinutes()]).toEqual([9, 0]);
    expect(moved).toEqual(["c1"]);
    const [message, opts] = toastSuccess.mock.calls[0] as [string, { action: { label: string; onClick: () => void } }];
    expect(message).toMatch(/^Adiada até amanhã 09:00$/);
    expect(opts.action.label).toBe("Desfazer");

    // Desfazer: back to awake (it was not snoozed before), note null.
    result = { data: { ...snoozedRow("T"), snoozed_until: null, snooze_note: null }, error: null };
    await act(async () => opts.action.onClick());
    expect(updates[1]).toEqual({ snoozed_until: null, snooze_note: null });
  });

  it("custom time: the guard's errors become pt-BR messages", async () => {
    render(<ConversationSnooze conversation={conv()} contactName="Ana" disabled={false} />);
    await openPopover();
    const input = screen.getByLabelText("Data e hora personalizadas");
    expect(input.getAttribute("min")).toBeTruthy();
    expect(input.getAttribute("max")).toBeTruthy();
    // Too soon is caught before the write.
    const soon = new Date(Date.now() + 20_000);
    const pad = (n: number) => String(n).padStart(2, "0");
    const local = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    fireEvent.change(input, { target: { value: local(new Date(soon.getTime() - 60_000)) } });
    // submit event directly: the browser's own min/max check would block it first
    fireEvent.submit((input as HTMLInputElement).form!);
    expect((await screen.findByRole("alert")).textContent).toBe("Escolha um horário daqui a pelo menos 1 minuto");
    expect(updates).toHaveLength(0);

    // 23514 (resolved / archived meanwhile).
    result = { data: null, error: { code: "23514", message: "check" } };
    fireEvent.change(input, { target: { value: local(new Date(Date.now() + 2 * 86_400_000)) } });
    // submit event directly: the browser's own min/max check would block it first
    fireEvent.submit((input as HTMLInputElement).form!);
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe("Conversas resolvidas ou arquivadas não podem ser adiadas"),
    );
    expect(input.getAttribute("aria-invalid")).toBe("true");
  });

  it("already snoozed: shows the time and Cancelar adiamento wakes it", async () => {
    const until = new Date(Date.now() + 86_400_000).toISOString();
    const onPatch = vi.fn();
    render(
      <ConversationSnooze conversation={conv({ snoozed_until: until, snooze_note: "x" })} contactName="Ana" disabled={false} onPatch={onPatch} />,
    );
    expect(screen.getByTestId("snooze-trigger").getAttribute("aria-label")).toMatch(/^Adiada até amanhã/);
    await openPopover();
    result = { data: { ...snoozedRow("T"), snoozed_until: null, snooze_note: null }, error: null };
    fireEvent.click(screen.getByText("Cancelar adiamento"));
    await waitFor(() => expect(onPatch).toHaveBeenCalled());
    expect(updates[0]).toEqual({ snoozed_until: null, snooze_note: null });
    expect(toastSuccess).toHaveBeenCalledWith("Adiamento cancelado");
  });

  it("h / palette open the header popover; viewers get a disabled control", async () => {
    render(<ConversationSnooze conversation={conv()} contactName="Ana" disabled={false} listenShortcut />);
    act(() => dispatchInboxShortcut("snooze"));
    await waitFor(() => expect(screen.getByText("Adiar conversa")).toBeTruthy());
    cleanup();
    render(<ConversationSnooze conversation={conv()} contactName="Ana" disabled listenShortcut />);
    expect((screen.getByTestId("snooze-trigger") as HTMLButtonElement).disabled).toBe(true);
    act(() => dispatchInboxShortcut("snooze"));
    expect(screen.queryByText("Adiar conversa")).toBeNull();
  });

  it("row variant: icon-only quick action labelled with the contact", () => {
    render(<ConversationSnooze variant="row" conversation={conv()} contactName="Ana" disabled={false} />);
    expect(screen.getByRole("button", { name: "Adiar conversa com Ana" })).toBeTruthy();
  });
});

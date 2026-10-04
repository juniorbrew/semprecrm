// @vitest-environment jsdom
import { useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const push = vi.fn();
let pathname = "/dashboard";
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
  usePathname: () => pathname,
}));

let role: "owner" | "admin" | "agent" | "viewer" = "agent";
let modules: Record<string, boolean> = {};
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: { id: "u1" },
    accountId: "acc-1",
    accountRole: role,
    preferences: { inbox_sla_minutes: 30, cooling_hours: 24 },
  }),
  useEntitlements: () => ({ ready: true, modules }),
}));
vi.mock("@/hooks/use-can", () => ({ useCan: () => role !== "viewer" }));

const signals: AbortSignal[] = [];
const rpc = vi.fn();
const from = vi.fn();
function chain(result: unknown) {
  const q: Record<string, unknown> = {};
  for (const m of ["select", "eq", "or", "order", "limit"]) q[m] = () => q;
  q.abortSignal = (s: AbortSignal) => {
    signals.push(s);
    return Promise.resolve(result);
  };
  return q;
}
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({ rpc, from }) }));

import { CommandPalette } from "./command-palette";
import { INBOX_SHORTCUT_EVENT } from "@/lib/inbox/shortcuts";

function Harness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button">antes</button>
      <CommandPalette open={open} onOpenChange={setOpen} />
    </>
  );
}

const ctrlK = () => fireEvent.keyDown(document.activeElement ?? document.body, { key: "k", ctrlKey: true });
const input = () => screen.getByRole("combobox");
const optionLabels = () => screen.queryAllByRole("option").map((o) => o.textContent);

beforeEach(() => {
  // jsdom has no layout.
  Element.prototype.scrollIntoView = vi.fn();
  role = "agent";
  pathname = "/dashboard";
  modules = {
    dashboard: true, inbox: true, contacts: true, pipelines: true, broadcasts: true, automations: true,
    flows: true, ai: true, tasks: true, calendar: true, internal_chat: true,
  };
  localStorage.clear();
  signals.length = 0;
  rpc.mockImplementation(() =>
    chain({ data: [{ id: "c1", contact: { id: "k1", name: "Ana Souza", phone: "+55 11 99999-0000", company: "Acme" } }], error: null }),
  );
  from.mockImplementation(() => chain({ data: [{ id: "k2", name: "Ana Lima", phone: "+55 21 98888-0000", company: null }], error: null }));
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("CommandPalette", () => {
  it("Ctrl+K opens with the field focused; Esc closes and restores focus", async () => {
    render(<Harness />);
    const before = screen.getByRole("button", { name: "antes" });
    before.focus();
    act(() => void ctrlK());
    await waitFor(() => expect(input()).toBe(document.activeElement));
    expect(screen.getByRole("listbox")).toBeTruthy();

    fireEvent.keyDown(input(), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("combobox")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(before));
  });

  it("Ctrl+K again closes it", async () => {
    render(<Harness />);
    act(() => void ctrlK());
    await waitFor(() => expect(input()).toBeTruthy());
    act(() => void ctrlK());
    await waitFor(() => expect(screen.queryByRole("combobox")).toBeNull());
  });

  it("Ir para follows the sidebar gating (role and plan modules)", async () => {
    modules.broadcasts = false;
    render(<Harness />);
    act(() => void ctrlK());
    await waitFor(() => expect(input()).toBeTruthy());
    const labels = optionLabels();
    expect(labels).toContain("Funis");
    expect(labels).toContain("Nova tarefa");
    expect(labels).not.toContain("Disparos");
    expect(labels).not.toContain("Relatórios"); // owner / admin only
    // Not on /inbox with a resolvable conversation: no "Resolver".
    expect(labels.some((l) => l?.startsWith("Resolver"))).toBe(false);
    expect(labels.some((l) => l?.startsWith("Adiar"))).toBe(false);
  });

  it("Adiar conversa atual… only on /inbox with a snoozable conversation; runs the h shortcut", async () => {
    const seen: string[] = [];
    const onShortcut = (e: Event) => seen.push((e as CustomEvent<string>).detail);
    window.addEventListener(INBOX_SHORTCUT_EVENT, onShortcut);
    pathname = "/inbox";
    const marker = document.createElement("div");
    marker.setAttribute("data-inbox-snoozable", "true");
    document.body.appendChild(marker);
    render(<Harness />);
    act(() => void ctrlK());
    await waitFor(() => expect(input()).toBeTruthy());
    const option = screen.getAllByRole("option").find((o) => o.textContent?.startsWith("Adiar conversa atual"));
    expect(option?.textContent).toContain("H");
    fireEvent.click(option!);
    await waitFor(() => expect(seen).toEqual(["snooze"]));
    window.removeEventListener(INBOX_SHORTCUT_EVENT, onShortcut);
    marker.remove();
  });

  it("viewers get no Nova tarefa; owners see Relatórios", async () => {
    role = "viewer";
    const { unmount } = render(<Harness />);
    act(() => void ctrlK());
    await waitFor(() => expect(input()).toBeTruthy());
    expect(optionLabels()).not.toContain("Nova tarefa");
    unmount();

    role = "owner";
    render(<Harness />);
    act(() => void ctrlK());
    await waitFor(() => expect(input()).toBeTruthy());
    expect(optionLabels()).toContain("Relatórios");
  });

  it("arrows move the active option and Enter navigates", async () => {
    render(<Harness />);
    act(() => void ctrlK());
    await waitFor(() => expect(input()).toBeTruthy());
    fireEvent.change(input(), { target: { value: "fun" } });
    const first = screen.getAllByRole("option")[0];
    expect(first.textContent).toBe("Funis");
    expect(input().getAttribute("aria-activedescendant")).toBe(first.id);
    expect(first.getAttribute("aria-selected")).toBe("true");

    fireEvent.change(input(), { target: { value: "" } });
    const all = screen.getAllByRole("option");
    fireEvent.keyDown(input(), { key: "ArrowDown" });
    expect(input().getAttribute("aria-activedescendant")).toBe(all[1].id);
    fireEvent.keyDown(input(), { key: "ArrowUp" });
    fireEvent.keyDown(input(), { key: "ArrowUp" });
    // Wraps to the last option.
    expect(input().getAttribute("aria-activedescendant")).toBe(all[all.length - 1].id);

    fireEvent.change(input(), { target: { value: "funis" } });
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(push).toHaveBeenCalledWith("/pipelines");
    await waitFor(() => expect(screen.queryByRole("combobox")).toBeNull());
  });

  it("searches conversations and contacts (debounced, stale requests aborted) and remembers the pick", async () => {
    render(<Harness />);
    act(() => void ctrlK());
    await waitFor(() => expect(input()).toBeTruthy());
    fireEvent.change(input(), { target: { value: "an" } });
    fireEvent.change(input(), { target: { value: "ana" } });

    const conversations = await screen.findByRole("group", { name: "Conversas" });
    const contacts = screen.getByRole("group", { name: "Contatos" });
    expect(within(conversations).getByRole("option").textContent).toContain("Ana Souza");
    expect(within(contacts).getByRole("option").textContent).toContain("Ana Lima");
    // While typing, records come first and the first one is active.
    expect(screen.getAllByRole("option")[0].getAttribute("aria-selected")).toBe("true");
    expect(screen.getAllByRole("option")[0].textContent).toContain("Ana Souza");
    // Debounced: the "an" keystroke never reached the database.
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_account_id: "acc-1", p_tab: "all", p_pattern: "%ana%", p_limit: 6 });

    fireEvent.click(within(conversations).getByRole("option"));
    expect(push).toHaveBeenCalledWith("/inbox?c=c1");
    expect(localStorage.getItem("semprecrm:palette:recent:u1")).toContain("/inbox?c=c1");

    // Reopened with an empty query: Recentes lists it first.
    await waitFor(() => expect(screen.queryByRole("combobox")).toBeNull());
    act(() => void ctrlK());
    const recent = await screen.findByRole("group", { name: "Recentes" });
    expect(within(recent).getAllByRole("option")[0].textContent).toBe("Ana Souza");
  });

  it("a newer query aborts the request still in flight", async () => {
    let release: (v: unknown) => void = () => {};
    rpc.mockImplementationOnce(() => {
      const q = chain(null);
      q.abortSignal = (s: AbortSignal) => {
        signals.push(s);
        return new Promise((r) => (release = r));
      };
      return q;
    });
    render(<Harness />);
    act(() => void ctrlK());
    await waitFor(() => expect(input()).toBeTruthy());
    fireEvent.change(input(), { target: { value: "ana" } });
    await waitFor(() => expect(signals.length).toBeGreaterThan(0));
    fireEvent.change(input(), { target: { value: "anab" } });
    expect(signals[0].aborted).toBe(true);
    release({ data: [{ id: "stale", contact: { id: "x", name: "Stale", phone: "", company: null } }], error: null });
    await screen.findByRole("group", { name: "Conversas" });
    expect(optionLabels().join()).not.toContain("Stale");
  });
});

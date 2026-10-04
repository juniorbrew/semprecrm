// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { INBOX_SHORTCUT_EVENT } from "@/lib/inbox/shortcuts";
import { useInboxShortcuts } from "./use-inbox-shortcuts";

function Inbox({ canResolve = true, canClaim = true, quickDisabled = false, canSnooze = false }) {
  useInboxShortcuts({ hasActive: true, canClaim, canResolve, canSnooze }, () => {});
  return (
    <div>
      <input data-inbox-search aria-label="busca" />
      <textarea data-inbox-composer aria-label="resposta" />
      <button type="button" data-inbox-quick-replies disabled={quickDisabled} onClick={onQuick}>
        respostas
      </button>
    </div>
  );
}

const onQuick = vi.fn();
function dispatched() {
  const seen: string[] = [];
  const listener = (e: Event) => seen.push((e as CustomEvent<string>).detail);
  window.addEventListener(INBOX_SHORTCUT_EVENT, listener);
  return { seen, stop: () => window.removeEventListener(INBOX_SHORTCUT_EVENT, listener) };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("useInboxShortcuts", () => {
  it("h dispatches snooze for agents only, never from the composer", () => {
    render(<Inbox canSnooze />);
    const d = dispatched();
    fireEvent.keyDown(document.body, { key: "h" });
    fireEvent.keyDown(screen.getByRole("textbox", { name: "resposta" }), { key: "h" });
    d.stop();
    expect(d.seen).toEqual(["snooze"]);
    cleanup();
    render(<Inbox />);
    const v = dispatched();
    fireEvent.keyDown(document.body, { key: "h" });
    v.stop();
    expect(v.seen).toEqual([]);
  });

  it("e resolves, Shift+A claims, j / k move — from the page body", () => {
    render(<Inbox />);
    const d = dispatched();
    for (const init of [{ key: "e" }, { key: "A", shiftKey: true }, { key: "j" }, { key: "k" }]) {
      fireEvent.keyDown(document.body, init);
    }
    d.stop();
    expect(d.seen).toEqual(["resolve", "claim", "next", "prev"]);
  });

  it("nothing fires while typing in the composer", () => {
    render(<Inbox />);
    const d = dispatched();
    const composer = screen.getByRole("textbox", { name: "resposta" });
    for (const key of ["e", "j", "/"]) fireEvent.keyDown(composer, { key });
    fireEvent.keyDown(composer, { key: "A", shiftKey: true });
    d.stop();
    expect(d.seen).toEqual([]);
    expect(onQuick).not.toHaveBeenCalled();
  });

  it("viewer rules (no resolve / claim) send nothing", () => {
    render(<Inbox canResolve={false} canClaim={false} />);
    const d = dispatched();
    fireEvent.keyDown(document.body, { key: "e" });
    fireEvent.keyDown(document.body, { key: "A", shiftKey: true });
    d.stop();
    expect(d.seen).toEqual([]);
  });

  it('"/" opens the quick replies, or focuses the search when they are unavailable', () => {
    const { unmount } = render(<Inbox />);
    fireEvent.keyDown(document.body, { key: "/" });
    expect(onQuick).toHaveBeenCalledTimes(1);
    unmount();

    render(<Inbox quickDisabled />);
    fireEvent.keyDown(document.body, { key: "/" });
    expect(onQuick).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "busca" }));
  });

  it("an open dialog owns the keyboard", () => {
    render(
      <>
        <Inbox />
        <div role="dialog" />
      </>,
    );
    const d = dispatched();
    fireEvent.keyDown(document.body, { key: "e" });
    d.stop();
    expect(d.seen).toEqual([]);
  });
});

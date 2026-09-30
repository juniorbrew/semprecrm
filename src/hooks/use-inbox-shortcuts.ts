"use client";

import { useEffect, useRef } from "react";
import {
  classifyTarget,
  redirectForPendingCursor,
  dispatchInboxShortcut,
  resolveShortcut,
  type ShortcutContext,
} from "@/lib/inbox/shortcuts";

/** A dialog / menu / popover is open somewhere: it owns the keyboard. */
const OVERLAY_SELECTOR =
  '[role="dialog"], [role="alertdialog"], [role="menu"], [data-slot="popover-content"]';

/**
 * Global inbox keydown -> `resolveShortcut`. DOM-only actions (focus the
 * search / reply box, leave a field) run here; the rest goes out as a window
 * event for the list (next / prev / open) and the thread (claim / resolve).
 */
export function useInboxShortcuts(
  ctx: Omit<ShortcutContext, "overlayOpen">,
  onHelp: () => void,
  enabled = true,
) {
  const enabledRef = useRef(enabled);
  const ctxRef = useRef(ctx);
  const helpRef = useRef(onHelp);
  useEffect(() => {
    ctxRef.current = ctx;
    helpRef.current = onHelp;
    enabledRef.current = enabled;
  });

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || !enabledRef.current) return;
      const action = resolveShortcut(
        {
          key: e.key,
          ctrlKey: e.ctrlKey,
          metaKey: e.metaKey,
          altKey: e.altKey,
          shiftKey: e.shiftKey,
          isComposing: e.isComposing,
          repeat: e.repeat,
          target: classifyTarget(e.target as Element | null),
        },
        { ...ctxRef.current, overlayOpen: !!document.querySelector(OVERLAY_SELECTOR) },
      );
      if (!action) return;
      e.preventDefault();
      const pending = !!document.querySelector("[data-inbox-cursor-pending]");
      switch (redirectForPendingCursor(action, pending)) {
        case "help":
          helpRef.current();
          break;
        case "blur":
          (document.activeElement as HTMLElement | null)?.blur();
          break;
        case "focusSearch":
          document.querySelector<HTMLElement>("[data-inbox-search]")?.focus();
          break;
        case "focusComposer":
          document.querySelector<HTMLElement>("[data-inbox-composer]")?.focus();
          break;
        case "open":
          dispatchInboxShortcut("open");
          break;
        default:
          dispatchInboxShortcut(action);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}

"use client";

import { createContext, useCallback, useContext, useState } from "react";
import { ChevronDown, Loader2, Plus } from "lucide-react";
import { cn } from "@/lib/utils";

const STORAGE_KEY = "sempre:inbox-panel:sections";

interface SectionCtx {
  open: boolean;
  toggle: () => void;
}

const SectionContext = createContext<SectionCtx | null>(null);

/** Remembered open/closed state per section id; never throws (private mode, blocked storage). */
export function readSectionOpen(id: string, fallback: boolean): boolean {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const map = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    return typeof map[id] === "boolean" ? (map[id] as boolean) : fallback;
  } catch {
    return fallback;
  }
}

function writeSectionOpen(id: string, open: boolean): void {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const map = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...map, [id]: open }));
  } catch {
    /* remembering is a convenience only */
  }
}

/**
 * Collapsible wrapper for a panel section. The section's root element
 * must be `<div>{header}{body…}</div>` (all panel sections are): when
 * collapsed everything after the header is `display:none`, so the body
 * stays mounted (no refetch, no layout thrash) and the header keeps its
 * height. The `SectionHeader` inside turns into the toggle.
 */
export function PanelSection({
  id,
  defaultOpen = true,
  lazyHeader,
  children,
}: {
  id: string;
  defaultOpen?: boolean;
  /**
   * Lazy mode: while the section has never been open only this header
   * (a `SectionHeader`) is rendered, so the section's own queries do not
   * fire until the first expand. Once opened the children stay mounted.
   */
  lazyHeader?: React.ReactNode;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(() => readSectionOpen(id, defaultOpen));
  const [opened, setOpened] = useState(open);
  const toggle = useCallback(() => {
    const next = !open;
    setOpen(next);
    if (next) setOpened(true);
    writeSectionOpen(id, next);
  }, [id, open]);
  return (
    <SectionContext.Provider value={{ open, toggle }}>
      <div
        data-collapsed={!open}
        className="[&[data-collapsed=true]>*>*:not(:first-child)]:hidden"
      >
        {opened || !lazyHeader ? children : <div>{lazyHeader}</div>}
      </div>
    </SectionContext.Provider>
  );
}

/** The small "+" at the right of a section header (Etiquetas style). */
export function SectionAddButton({
  label,
  onClick,
  disabled,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
    >
      {disabled ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      ) : (
        <Plus className="h-3.5 w-3.5" />
      )}
    </button>
  );
}

export function SectionHeader({
  icon: Icon,
  label,
  count,
  action,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  count?: number;
  action?: React.ReactNode;
}) {
  const section = useContext(SectionContext);
  const title = (
    <>
      <Icon className="h-3 w-3" />
      <span>{label}</span>
      {typeof count === "number" && count > 0 && (
        <span className="rounded-full bg-muted px-1.5 text-[10px] font-semibold tabular-nums text-muted-foreground">
          {count}
        </span>
      )}
    </>
  );
  const titleCls =
    "flex items-center gap-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground";
  return (
    <div className="flex min-h-6 items-center justify-between gap-2 px-1">
      {section ? (
        <button
          type="button"
          onClick={section.toggle}
          aria-expanded={section.open}
          className={cn(titleCls, "min-w-0 rounded-md text-left transition-colors hover:text-foreground")}
        >
          {title}
          <ChevronDown
            className={cn("h-3 w-3 shrink-0 transition-transform", !section.open && "-rotate-90")}
            aria-hidden
          />
        </button>
      ) : (
        <div className={titleCls}>{title}</div>
      )}
      {action}
    </div>
  );
}

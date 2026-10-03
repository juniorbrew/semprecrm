"use client";

import { Rows4 } from "lucide-react";

import { cn } from "@/lib/utils";

import type { Density } from "./density";

/** Ghost icon toggle for compact rows (pressed = compact), as on Funis / Contatos. */
export function DensityToggle({
  density,
  onToggle,
  label,
  className,
}: {
  density: Density;
  onToggle: () => void;
  /** "Lista compacta" / "Compact list"… */
  label: string;
  className?: string;
}) {
  const compact = density === "compact";
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={compact}
      aria-label={label}
      title={label}
      data-testid="density-toggle"
      className={cn(
        "inline-flex size-8 shrink-0 items-center justify-center rounded-md transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none",
        compact ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted hover:text-foreground",
        className,
      )}
    >
      <Rows4 className="size-4" aria-hidden />
    </button>
  );
}

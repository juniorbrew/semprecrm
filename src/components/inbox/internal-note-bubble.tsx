"use client";

import { Lock, Trash2 } from "lucide-react";
import { format } from "date-fns";
import { cn } from "@/lib/utils";
import type { ContactNote } from "@/types";

interface InternalNoteBubbleProps {
  note: ContactNote;
  /** Display name of the teammate who wrote it. */
  authorName: string;
  /** Label for the lock chip — pt-BR "Nota interna" / en "Internal note". */
  label: string;
  /** Hover hint explaining the note never reaches WhatsApp. */
  hint: string;
  /** Present only when the current user may delete it. */
  onDelete?: () => void;
  deleteLabel?: string;
}

/**
 * Amber "sticky note" bubble for a private team note in the thread.
 * Right-aligned like agent messages (it's ours), but visually distinct —
 * dashed amber border, lock chip, no delivery ticks — so nobody mistakes
 * it for something the customer can read.
 */
export function InternalNoteBubble({
  note,
  authorName,
  label,
  hint,
  onDelete,
  deleteLabel,
}: InternalNoteBubbleProps) {
  const time = format(new Date(note.created_at), "HH:mm");
  return (
    <div className="flex justify-end" data-no-translate>
      <div
        title={hint}
        className={cn(
          "group/note relative max-w-[75%] rounded-2xl rounded-br-md border border-dashed border-amber-500/50 bg-amber-500/15 px-3 py-2 text-foreground shadow-sm",
        )}
      >
        <div className="mb-1 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-amber-500">
          <Lock className="h-3 w-3" />
          <span>{label}</span>
          <span className="font-normal normal-case tracking-normal text-muted-foreground">
            · {authorName}
          </span>
        </div>
        <p className="whitespace-pre-wrap break-words text-sm">{note.note_text}</p>
        <div className="mt-1 flex items-center justify-end gap-2">
          {onDelete && (
            <button
              type="button"
              onClick={onDelete}
              aria-label={deleteLabel}
              title={deleteLabel}
              className="rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:text-red-500 focus-visible:opacity-100 group-hover/note:opacity-100"
            >
              <Trash2 className="h-3 w-3" />
            </button>
          )}
          <span className="text-[10px] text-muted-foreground">
            {time}
          </span>
        </div>
      </div>
    </div>
  );
}

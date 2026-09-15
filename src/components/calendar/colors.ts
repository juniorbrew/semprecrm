// ============================================================
// Event colours — a stable palette per owner (hash of user_id) or
// the colour picked on the event. Hex so the same value works for
// the chip background, the left border and the swatch picker.
// ============================================================

import type { CalendarEvent } from "@/lib/calendar";

/** Swatches offered in the drawer; `colorForUser` draws from the same list. */
export const EVENT_COLORS = [
  "#2563eb", // blue
  "#059669", // emerald
  "#d97706", // amber
  "#dc2626", // red
  "#7c3aed", // violet
  "#db2777", // pink
  "#0891b2", // cyan
  "#65a30d", // lime
  "#ea580c", // orange
  "#475569", // slate
] as const;

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Same user → same colour, on every device and after every reload. */
export function colorForUser(userId: string | null | undefined): string {
  if (!userId) return EVENT_COLORS[EVENT_COLORS.length - 1];
  return EVENT_COLORS[hash(userId) % EVENT_COLORS.length];
}

/** The event's own colour when set, else its owner's palette colour. */
export function eventColor(event: Pick<CalendarEvent, "color" | "owner_user_id">): string {
  return event.color && /^#[0-9a-f]{6}$/i.test(event.color) ? event.color : colorForUser(event.owner_user_id);
}

/** Inline styles for a chip: tinted background, solid left border, readable text. */
export function chipStyle(color: string, cancelled = false): React.CSSProperties {
  return {
    backgroundColor: `${color}${cancelled ? "14" : "26"}`,
    borderLeftColor: color,
    color: cancelled ? undefined : color,
  };
}

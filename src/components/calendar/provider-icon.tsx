import type { CalendarProvider } from "@/types";
import { cn } from "@/lib/utils";

/**
 * Tiny brand-neutral glyphs for the two calendar providers — a "G"
 * roundel for Google and the four-tile mark for Microsoft. Used on
 * external event chips, the drawer badge and Settings → Agenda.
 */
export function ProviderIcon({
  provider,
  className,
  title,
}: {
  provider: CalendarProvider;
  className?: string;
  title?: string;
}) {
  if (provider === "google") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden={!title} role={title ? "img" : undefined} className={cn("h-3 w-3 shrink-0", className)}>
        {title && <title>{title}</title>}
        <path fill="#4285F4" d="M21.6 12.2c0-.7-.1-1.4-.2-2H12v3.9h5.4a4.6 4.6 0 0 1-2 3v2.5h3.2c1.9-1.7 3-4.3 3-7.4z" />
        <path fill="#34A853" d="M12 22c2.7 0 5-.9 6.6-2.4l-3.2-2.5c-.9.6-2 1-3.4 1-2.6 0-4.8-1.8-5.6-4.1H3.1v2.6A10 10 0 0 0 12 22z" />
        <path fill="#FBBC05" d="M6.4 14a6 6 0 0 1 0-3.9V7.5H3.1a10 10 0 0 0 0 9l3.3-2.5z" />
        <path fill="#EA4335" d="M12 6c1.5 0 2.8.5 3.8 1.5l2.8-2.8A10 10 0 0 0 3.1 7.5L6.4 10C7.2 7.8 9.4 6 12 6z" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" aria-hidden={!title} role={title ? "img" : undefined} className={cn("h-3 w-3 shrink-0", className)}>
      {title && <title>{title}</title>}
      <rect x="2" y="2" width="9.5" height="9.5" fill="#F25022" />
      <rect x="12.5" y="2" width="9.5" height="9.5" fill="#7FBA00" />
      <rect x="2" y="12.5" width="9.5" height="9.5" fill="#00A4EF" />
      <rect x="12.5" y="12.5" width="9.5" height="9.5" fill="#FFB900" />
    </svg>
  );
}

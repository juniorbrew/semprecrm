import type { Language } from "@/lib/i18n";
import { describeLastSeen } from "@/lib/chat";

/**
 * "Last seen X ago" wording for the people list and the thread header.
 * Portuguese reads "Visto há 5 min"; English "Last seen 5 min ago" —
 * the suffix is the only language-specific piece, so it stays here
 * rather than growing the catalogue with one key per unit.
 */
export function lastSeenLabel(
  iso: string | null | undefined,
  now: number,
  language: Language,
  t: (english: string) => string,
): string {
  const d = describeLastSeen(iso, now);
  if (d.kind === "never") return t("Offline");
  if (d.kind === "now") return t("Last seen just now");
  if (d.kind === "long") return t("Last seen a long time ago");
  const unit =
    d.kind === "minutes"
      ? "min"
      : d.kind === "hours"
        ? "h"
        : d.kind === "days"
          ? "d"
          : t("wk");
  const suffix = language === "pt-BR" ? "" : ` ${t("ago")}`;
  return `${t("Last seen")} ${d.n} ${unit}${suffix}`;
}

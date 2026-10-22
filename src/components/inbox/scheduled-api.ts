import { SCHEDULED_COPY } from "./scheduled-copy";
import type { Language } from "@/lib/i18n";

/** Row as the list endpoints return it. */
export interface ScheduledItem {
  id: string;
  conversation_id: string;
  created_by: string;
  content_text: string;
  scheduled_for: string;
  status: "pending" | "sending" | "failed";
  error_code: string | null;
  error_text: string | null;
  contact_name?: string | null;
}

export const MAYBE_SENT = "maybe_sent";

export async function call(url: string, init?: RequestInit): Promise<Record<string, unknown>> {
  const res = await fetch(url, init);
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error(typeof body.error === "string" ? body.error : "request failed");
  return body;
}

/** Author or admin+ (the API enforces the same rule). */
export function canManageItem(item: ScheduledItem, userId: string | null | undefined, isAdmin: boolean): boolean {
  return isAdmin || (!!userId && item.created_by === userId);
}

/**
 * "Enviar agora" / "Tentar de novo". A row that MAY already have gone out
 * asks the agent to check the conversation first; false = they declined.
 */
export async function sendScheduled(item: ScheduledItem, language: Language): Promise<boolean> {
  const copy = SCHEDULED_COPY[language] ?? SCHEDULED_COPY["pt-BR"];
  const risky = item.error_code === MAYBE_SENT;
  if (risky && !window.confirm(copy.confirmMaybeSent)) return false;
  await call(`/api/inbox/scheduled/${item.id}/send`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(risky ? { confirm: true } : {}),
  });
  return true;
}

/** Cancel returns the stored text so the caller can hand it back. */
export async function cancelScheduled(item: ScheduledItem): Promise<string> {
  const body = await call(`/api/inbox/scheduled/${item.id}`, { method: "DELETE" });
  return typeof body.content_text === "string" ? body.content_text : item.content_text;
}

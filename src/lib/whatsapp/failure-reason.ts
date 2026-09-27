import type { Message } from "@/types";

/**
 * "[code] title — details" for a failed outbound message, or null when
 * the row predates migration 052 / Meta sent no reason. Shared by the
 * inbox bubble's failed-icon tooltip and the line under it (wacrm #535).
 */
export function failureReason(
  message: Pick<Message, "status" | "error_code" | "error_title" | "error_details">,
): string | null {
  if (message.status !== "failed" || !message.error_title) return null;
  const base = message.error_code
    ? `[${message.error_code}] ${message.error_title}`
    : message.error_title;
  return message.error_details ? `${base} — ${message.error_details}` : base;
}

/**
 * The same reason folded into one line for `broadcast_recipients.error_message`
 * (a free-text column since migration 001): "[code] title: details".
 */
export function recipientErrorMessage(failure: {
  code: number;
  title: string;
  details: string | null;
}): string {
  return (
    `[${failure.code}] ${failure.title}` +
    (failure.details ? `: ${failure.details}` : "")
  );
}

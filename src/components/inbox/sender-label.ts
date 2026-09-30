import type { Message } from "@/types";

/**
 * Who sent an outbound bubble (inbox package 1). `text` is either a
 * dictionary key the DOM translator localizes ("You" → "Você",
 * "Mobile phone" → "Celular"…) or, with `translate: false`, a teammate's
 * name that must be rendered as is.
 */
export interface SenderLabel {
  kind: "you" | "agent" | "phone" | "automation" | "bot" | "system" | "ai";
  text: string;
  translate: boolean;
  /** Longer explanation for the tooltip (a dictionary key). */
  hint?: string;
}

export interface SenderLabelContext {
  currentUserId?: string | null;
  /** Teammate's display name by user id; undefined when unknown. */
  nameFor?: (userId: string) => string | undefined;
}

/** Null for the customer's own messages — the thread already says who they are. */
export function senderLabelFor(
  message: Pick<Message, "sender_type" | "sender_id" | "origin">,
  ctx: SenderLabelContext = {},
): SenderLabel | null {
  if (message.sender_type === "customer") return null;

  switch (message.origin) {
    case "phone":
      return {
        kind: "phone",
        text: "Mobile phone",
        translate: true,
        hint: "Sent from the phone or WhatsApp Web",
      };
    case "automation":
      return { kind: "automation", text: "Automation", translate: true };
    case "flow":
      return { kind: "bot", text: "Bot", translate: true };
    case "system":
      return { kind: "system", text: "System", translate: true };
    case "ai":
      return { kind: "ai", text: "AI", translate: true, hint: "Sent automatically by the AI agent" };
  }

  // Legacy engine rows (before migration 059) carry no origin.
  if (message.sender_type === "bot") {
    return { kind: "automation", text: "Automation", translate: true };
  }

  const senderId = message.sender_id;
  if (senderId && ctx.currentUserId && senderId === ctx.currentUserId) {
    return { kind: "you", text: "You", translate: true };
  }
  const name = senderId ? ctx.nameFor?.(senderId)?.trim() : undefined;
  if (name) return { kind: "agent", text: name, translate: false };
  return { kind: "agent", text: "Agent", translate: true };
}

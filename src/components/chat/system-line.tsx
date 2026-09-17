"use client";

import { useLanguage } from "@/hooks/use-language";
import { parseSystemEvent } from "@/lib/chat";
import type { ChatMessage } from "@/types";

interface SystemLineProps {
  message: ChatMessage;
  userId: string;
  nameOf: (userId: string) => string;
}

/** "a, b e c" / "a, b and c". */
function joinNames(names: string[], and: string): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} ${and} ${names[names.length - 1]}`;
}

/**
 * Centered line for a `kind: 'system'` message (group created, members
 * added / removed, someone left), worded in the viewer's language from
 * the JSON body.
 */
export function SystemLine({ message, userId, nameOf }: SystemLineProps) {
  const { t } = useLanguage();
  const event = parseSystemEvent(message.body);
  if (!event) return null;
  const actor = message.sender_id === userId ? t("You") : nameOf(message.sender_id);
  const who = (ids: string[]) => joinNames(ids.map((id) => (id === userId ? t("You").toLowerCase() : nameOf(id))), t("and"));
  let text: string;
  switch (event.event) {
    case "created":
      text = `${actor} ${t("created the group")}`;
      break;
    case "added":
      text = `${actor} ${t("added")} ${who(event.users)}`;
      break;
    case "removed":
      text = `${actor} ${t("removed")} ${who(event.users)}`;
      break;
    case "left":
      text = `${actor} ${t("left the group")}`;
      break;
  }
  return (
    <div className="my-2 flex justify-center" data-message-id={message.id}>
      <span className="max-w-[85%] rounded-full bg-muted/70 px-3 py-1 text-center text-[11px] text-muted-foreground">
        {text}
      </span>
    </div>
  );
}

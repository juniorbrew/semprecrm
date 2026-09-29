"use client";

import { useEffect, useRef } from "react";
import { createClient } from "@/lib/supabase/client";
import type { Contact, Conversation } from "@/types";

/**
 * Merge a realtime contacts UPDATE into the inbox list: every
 * conversation of that contact gets the fresh row (the QR gateway fills
 * `avatar_url` seconds after a message). Returns the same array when no
 * conversation matches, so React skips the re-render.
 */
export function applyContactUpdate(
  conversations: Conversation[],
  updated: Contact,
): Conversation[] {
  if (!conversations.some((c) => c.contact_id === updated.id)) return conversations;
  return conversations.map((c) =>
    c.contact_id === updated.id ? { ...c, contact: { ...c.contact, ...updated } } : c,
  );
}

/**
 * Contacts UPDATEs for one account (migration 061 puts `contacts` in the
 * realtime publication). Its own channel, so an environment without the
 * migration only loses live photos, never the inbox's message feed.
 */
export function useContactUpdates(
  accountId: string | null | undefined,
  onUpdate: (contact: Contact) => void,
) {
  const onUpdateRef = useRef(onUpdate);
  useEffect(() => {
    onUpdateRef.current = onUpdate;
  });

  useEffect(() => {
    if (!accountId) return;
    const supabase = createClient();
    const channel = supabase
      .channel(`inbox-contacts-${accountId}`)
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "contacts",
          filter: `account_id=eq.${accountId}`,
        },
        (payload) => onUpdateRef.current(payload.new as Contact),
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [accountId]);
}

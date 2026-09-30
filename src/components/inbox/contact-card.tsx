"use client";

import { useEffect, useState } from "react";
import { MessageSquare, Phone, UserPlus } from "lucide-react";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { useLanguage } from "@/hooks/use-language";
import { findExistingContact, isUniqueViolation } from "@/lib/contacts/dedupe";
import { findConversationByContact } from "@/lib/conversations/find-by-contact";
import { parseVCards, type VCardContact } from "@/lib/inbox/vcard";
import type { Contact, Conversation } from "@/types";
import { ContactAvatar } from "./contact-avatar";

type Known =
  | { state: "checking" }
  | { state: "none" }
  | { state: "known"; contact: Contact; conversation: Conversation | null };

function OneCard({
  card,
  onOpenConversation,
}: {
  card: VCardContact;
  onOpenConversation?: (conversation: Conversation) => void;
}) {
  const { t } = useLanguage();
  const { accountId, user } = useAuth();
  const digits = card.digits[0] ?? "";
  const [known, setKnown] = useState<Known>({ state: digits ? "checking" : "none" });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!digits || !accountId) return;
    let cancelled = false;
    const supabase = createClient();
    (async () => {
      const existing = await findExistingContact(supabase, accountId, digits);
      if (cancelled) return;
      if (!existing) return setKnown({ state: "none" });
      const conversation = await findConversationByContact(supabase, existing.id);
      if (!cancelled) {
        setKnown({ state: "known", contact: existing as unknown as Contact, conversation });
      }
    })().catch(() => {
      if (!cancelled) setKnown({ state: "none" });
    });
    return () => {
      cancelled = true;
    };
  }, [digits, accountId]);

  const save = async () => {
    if (!accountId || !user?.id || !digits || saving) return;
    setSaving(true);
    const { data, error } = await createClient()
      .from("contacts")
      .insert({
        user_id: user.id,
        account_id: accountId,
        name: card.name || null,
        phone: digits,
      })
      .select("*")
      .single();
    setSaving(false);
    if (error || !data) {
      // Someone saved it a second ago: just re-check instead of failing.
      toast.error(isUniqueViolation(error) ? t("Contact already saved") : t("Could not save the contact"));
      return;
    }
    toast.success(t("Contact saved"));
    setKnown({ state: "known", contact: data as Contact, conversation: null });
  };

  const btn =
    "inline-flex h-7 items-center gap-1.5 rounded-md border border-current/30 px-2 text-xs font-medium transition-colors hover:bg-current/10 disabled:opacity-60";

  return (
    <div className="flex w-56 max-w-full flex-col gap-2" data-testid="contact-card">
      <div className="flex items-center gap-2.5">
        <ContactAvatar src={null} name={card.name || "?"} className="h-9 w-9 bg-current/15 text-sm" />
        <div className="min-w-0" data-no-translate>
          <p className="truncate text-sm font-semibold">{card.name || card.phones[0]}</p>
          {card.phones[0] && (
            <p className="flex items-center gap-1 truncate text-xs opacity-80">
              <Phone className="h-3 w-3 shrink-0" aria-hidden />
              <span className="truncate">{card.phones[0]}</span>
            </p>
          )}
        </div>
      </div>
      {known.state === "none" && digits && (
        <button type="button" onClick={() => void save()} disabled={saving} className={btn}>
          <UserPlus className="h-3.5 w-3.5" aria-hidden />
          {t("Save as contact")}
        </button>
      )}
      {known.state === "known" && known.conversation && onOpenConversation && (
        <button
          type="button"
          onClick={() =>
            onOpenConversation({ ...known.conversation!, contact: known.conversation!.contact ?? known.contact })
          }
          className={btn}
        >
          <MessageSquare className="h-3.5 w-3.5" aria-hidden />
          {t("Open conversation")}
        </button>
      )}
    </div>
  );
}

/** Received contact card(s): name, number and the matching action. */
export function ContactCard({
  text,
  onOpenConversation,
}: {
  text: string;
  onOpenConversation?: (conversation: Conversation) => void;
}) {
  const cards = parseVCards(text);
  if (!cards) return null;
  return (
    <div className="flex flex-col gap-3">
      {cards.map((card, i) => (
        <OneCard key={`${card.digits[0] ?? card.name}-${i}`} card={card} onOpenConversation={onOpenConversation} />
      ))}
    </div>
  );
}

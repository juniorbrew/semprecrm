"use client";

import { useEffect, useState } from "react";
import { ExternalLink } from "lucide-react";

import { useLanguage } from "@/hooks/use-language";
import { createClient } from "@/lib/supabase/client";
import {
  channelLabel,
  LEAD_ORIGIN_COLUMNS,
  originLink,
  originName,
  type LeadOrigin,
  type OriginName,
} from "@/lib/lead-origins";

/** Touches of a contact, newest first (the deal drawer's dropdown). click_id is not selectable by the browser (migration 109). */
export function useContactOrigins(contactId: string | null | undefined) {
  const [state, setState] = useState<{ id: string | null; origins: LeadOrigin[]; error: boolean }>({
    id: null,
    origins: [],
    error: false,
  });
  useEffect(() => {
    if (!contactId) return;
    let cancelled = false;
    createClient()
      .from("lead_origins")
      .select(LEAD_ORIGIN_COLUMNS)
      .eq("contact_id", contactId)
      .order("occurred_at", { ascending: false })
      .limit(20)
      .then(({ data, error }) => {
        if (cancelled) return;
        setState({ id: contactId, origins: error ? [] : ((data ?? []) as unknown as LeadOrigin[]), error: !!error });
      });
    return () => {
      cancelled = true;
    };
  }, [contactId]);
  const ready = !contactId || state.id === contactId;
  return {
    origins: ready && contactId ? state.origins : [],
    loading: !!contactId && !ready,
    error: ready && state.error,
  };
}

/** The first and the last touch of a contact: its two pointers, then those two rows by id. */
export function useContactOriginPair(contactId: string | null | undefined) {
  const [state, setState] = useState<{ id: string | null; first: LeadOrigin | null; last: LeadOrigin | null; error: boolean }>({
    id: null,
    first: null,
    last: null,
    error: false,
  });
  useEffect(() => {
    if (!contactId) return;
    let cancelled = false;
    const done = (first: LeadOrigin | null, last: LeadOrigin | null, error: boolean) => {
      if (!cancelled) setState({ id: contactId, first, last, error });
    };
    const db = createClient();
    db.from("contacts")
      .select("first_origin_id, last_origin_id")
      .eq("id", contactId)
      .maybeSingle()
      .then(({ data, error }) => {
        if (cancelled) return;
        const ptr = data as { first_origin_id: string | null; last_origin_id: string | null } | null;
        if (error) return done(null, null, true);
        const ids = [...new Set([ptr?.first_origin_id, ptr?.last_origin_id].filter((v): v is string => !!v))];
        if (ids.length === 0) return done(null, null, false);
        db.from("lead_origins")
          .select(LEAD_ORIGIN_COLUMNS)
          .in("id", ids)
          .then(({ data: rows, error: err }) => {
            if (err) return done(null, null, true);
            const byId = new Map(((rows ?? []) as unknown as LeadOrigin[]).map((o) => [o.id, o]));
            done(byId.get(ptr?.first_origin_id ?? "") ?? null, byId.get(ptr?.last_origin_id ?? "") ?? null, false);
          });
      });
    return () => {
      cancelled = true;
    };
  }, [contactId]);
  const ready = !contactId || state.id === contactId;
  return {
    first: ready && contactId ? state.first : null,
    last: ready && contactId ? state.last : null,
    loading: !!contactId && !ready,
    error: ready && state.error,
  };
}

/** "Anúncio chamado “X” · Instagram · 3 nov." — the names are the customer's own data. */
export function OriginNameText({ n, date = null }: { n: OriginName; date?: string | null }) {
  const { t, language } = useLanguage();
  if (n.type === "direct") return <>{t("Direct or not identified")}</>;
  if (n.type === "paid") return <span data-no-translate>{n.name}</span>;
  const hasName = n.type !== "ad" || !!n.name;
  return (
    <>
      {n.type === "ad" && (n.name ? t("Ad called") : t("Ad without a title"))}
      {n.type === "campaign" && t("Campaign called")}
      {n.type === "referrer" && t("Visit coming from")}
      {hasName && (
        <>
          {" "}
          <span data-no-translate>{n.type === "referrer" ? n.name : `“${n.name}”`}</span>
        </>
      )}
      <span data-no-translate>
        {n.type !== "referrer" && n.channel ? ` · ${channelLabel(n.channel, language)}` : ""}
        {n.type === "campaign" && n.source ? ` · ${n.source}` : ""}
        {date ? ` · ${date}` : ""}
      </span>
    </>
  );
}

/**
 * A stored touch as one line, with the date. The "see the ad" link exists only for an ad or a post, always
 * shows where it goes (the host), and opens with noopener noreferrer: the address came with the message.
 */
export function OriginText({ origin, showDate = true }: { origin: LeadOrigin | null; showDate?: boolean }) {
  const { t, language } = useLanguage();
  const link = origin && (origin.kind === "ad" || origin.kind === "post") ? originLink(origin) : null;
  const date =
    showDate && origin
      ? new Intl.DateTimeFormat(language, { day: "numeric", month: "short" }).format(new Date(origin.occurred_at))
      : null;
  return (
    <span className="min-w-0 break-words">
      <OriginNameText n={originName(origin)} date={date} />
      {link && (
        <>
          {" "}
          <a
            href={link}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-0.5 text-primary underline underline-offset-2"
          >
            {t("See the ad")}
            <ExternalLink className="h-3 w-3" aria-hidden />
          </a>
          <span className="text-muted-foreground" data-no-translate>{` (${new URL(link).hostname})`}</span>
        </>
      )}
    </span>
  );
}

/**
 * "Veio de: …" for the inbox panel and the contact page. First and last touch the same (or only one):
 * one line. Different: "Primeiro contato" and "Último contato". No touch at all is "Direto ou não
 * identificado".
 */
export function OriginSummary({
  first,
  last,
  loading = false,
  error = false,
}: {
  first: LeadOrigin | null;
  last: LeadOrigin | null;
  loading?: boolean;
  error?: boolean;
}) {
  const { t } = useLanguage();
  const both = first && last && first.id !== last.id;
  return (
    <div className="space-y-0.5 text-xs leading-snug" data-testid="origin-summary">
      {loading ? (
        <p className="text-muted-foreground">{t("Loading...")}</p>
      ) : error ? (
        <p className="text-muted-foreground">{t("Could not load the origin.")}</p>
      ) : both ? (
        <>
          <p>
            <span className="text-muted-foreground">{t("First contact")}: </span>
            <OriginText origin={first} />
          </p>
          <p>
            <span className="text-muted-foreground">{t("Last contact")}: </span>
            <OriginText origin={last} />
          </p>
        </>
      ) : (
        <p>
          <span className="text-muted-foreground">{t("Came from")}: </span>
          <OriginText origin={last ?? first} />
        </p>
      )}
    </div>
  );
}

/** The summary of one contact, fetched by the component itself. */
export function ContactOrigin({ contactId }: { contactId: string | null | undefined }) {
  const { first, last, loading, error } = useContactOriginPair(contactId);
  if (!contactId) return null;
  return <OriginSummary first={first} last={last} loading={loading} error={error} />;
}

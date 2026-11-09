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

/** Touches of a contact, newest first. click_id is not selectable by the browser (migration 109). */
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

/** "Anúncio chamado “X” · Instagram · 3 nov." — the names are the customer's own data. */
export function OriginNameText({ n, date = null }: { n: OriginName; date?: string | null }) {
  const { t, language } = useLanguage();
  if (n.type === "direct") return <>{t("Direct or not identified")}</>;
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

/** A stored touch as one line, with the date and a link to the ad when there is one. */
export function OriginText({ origin, showDate = true }: { origin: LeadOrigin | null; showDate?: boolean }) {
  const { t, language } = useLanguage();
  const link = originLink(origin);
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
        </>
      )}
    </span>
  );
}

/**
 * "Veio de: …" for the inbox panel and the contact page. One touch: one line. Several: the first
 * and the last contact. No touch at all is "Direto ou não identificado".
 */
export function OriginSummary({
  origins,
  loading = false,
  error = false,
}: {
  origins: LeadOrigin[];
  loading?: boolean;
  error?: boolean;
}) {
  const { t } = useLanguage();
  const last = origins[0] ?? null;
  const first = origins.length > 1 ? origins[origins.length - 1] : null;
  return (
    <div className="space-y-0.5 text-xs leading-snug" data-testid="origin-summary">
      {loading ? (
        <p className="text-muted-foreground">{t("Loading...")}</p>
      ) : error ? (
        <p className="text-muted-foreground">{t("Could not load the origin.")}</p>
      ) : first ? (
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
          <OriginText origin={last} />
        </p>
      )}
    </div>
  );
}

/** The summary of one contact, fetched by the component itself. */
export function ContactOrigin({ contactId }: { contactId: string | null | undefined }) {
  const { origins, loading, error } = useContactOrigins(contactId);
  if (!contactId) return null;
  return <OriginSummary origins={origins} loading={loading} error={error} />;
}

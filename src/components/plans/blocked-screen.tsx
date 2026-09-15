"use client";

import Link from "next/link";
import { LogOut, Lock, Settings } from "lucide-react";

import { useAuth } from "@/hooks/use-auth";
import { useLanguage } from "@/hooks/use-language";
import { Button } from "@/components/ui/button";
import type { BlockReason } from "@/lib/plans";

/**
 * Copy per block reason. English keys — the i18n catalogue carries
 * the pt-BR versions (see `EN_TO_PT_EXTRA`).
 */
const REASON_COPY: Record<BlockReason, { title: string; body: string }> = {
  trial_expired: {
    title: "Your trial has ended",
    body: "The 14-day trial for this account is over. Choose a plan to keep using SempreCRM — your data is safe and will be right here when you come back.",
  },
  past_due: {
    title: "Payment past due",
    body: "We could not confirm the latest payment for this account. Settle the outstanding invoice to restore access.",
  },
  canceled: {
    title: "Subscription canceled",
    body: "This account's subscription was canceled. Reactivate it to get back in — nothing has been deleted.",
  },
  suspended: {
    title: "Account suspended",
    body: "This account was suspended by the platform team. Get in touch with support to find out why and how to restore access.",
  },
};

/**
 * Optional operator-configured support contact. Free text (an
 * e-mail, a WhatsApp link, a phone) rendered as-is; when it looks
 * like a URL or e-mail it becomes a link.
 */
function SupportContact() {
  const raw = process.env.NEXT_PUBLIC_SUPPORT_CONTACT?.trim();
  if (!raw) return null;
  const isUrl = /^https?:\/\//i.test(raw);
  const isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw);
  const href = isUrl ? raw : isEmail ? `mailto:${raw}` : null;
  return (
    <p className="text-sm text-muted-foreground">
      <span>Support: </span>
      {href ? (
        <a
          href={href}
          target={isUrl ? "_blank" : undefined}
          rel={isUrl ? "noreferrer" : undefined}
          className="font-medium text-primary underline-offset-4 hover:underline"
          data-no-translate
        >
          {raw}
        </a>
      ) : (
        <span className="font-medium text-foreground" data-no-translate>
          {raw}
        </span>
      )}
    </p>
  );
}

/**
 * Full-screen replacement for the dashboard content when the
 * account is blocked (status past_due / canceled / suspended, or an
 * expired trial). The shell (sidebar, header) is not rendered
 * around it — only Settings (so the owner can see the plan) and
 * sign-out remain reachable.
 */
export function BlockedScreen({ reason }: { reason: BlockReason }) {
  const { t } = useLanguage();
  const { signOut, account, isOwner } = useAuth();
  const copy = REASON_COPY[reason];

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6">
      <div className="w-full max-w-md rounded-2xl border border-border bg-card p-8 text-center shadow-sm">
        <div className="mx-auto mb-5 flex size-12 items-center justify-center rounded-full bg-destructive/10 text-destructive">
          <Lock className="size-6" aria-hidden="true" />
        </div>
        <h1 className="text-xl font-semibold text-foreground">{t(copy.title)}</h1>
        {account?.name ? (
          <p className="mt-1 truncate text-sm text-muted-foreground" data-no-translate>
            {account.name}
          </p>
        ) : null}
        <p className="mt-4 text-sm leading-relaxed text-muted-foreground">
          {t(copy.body)}
        </p>
        {!isOwner ? (
          <p className="mt-3 text-sm text-muted-foreground">
            {t("Ask the account owner to review the plan.")}
          </p>
        ) : null}
        <div className="mt-4">
          <SupportContact />
        </div>
        <div className="mt-6 flex flex-col gap-2 sm:flex-row sm:justify-center">
          <Button
            variant="outline"
            nativeButton={false}
            render={<Link href="/settings?tab=plan" />}
          >
            <Settings className="size-4" />
            {t("View plan")}
          </Button>
          <Button variant="ghost" onClick={signOut}>
            <LogOut className="size-4" />
            {t("Sign out")}
          </Button>
        </div>
      </div>
    </div>
  );
}

"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { ArrowLeft, KeyRound, Lock, ShieldCheck } from "lucide-react";

import { ModeToggle } from "@/components/layout/mode-toggle";
import { useLanguage } from "@/hooks/use-language";

const LOGIN_PATH = "/platform/login";

export function PlatformHeader() {
  const { t } = useLanguage();
  const pathname = usePathname();
  const router = useRouter();
  // On the lock screen the panel is closed: no access link, no lock button.
  const locked = pathname === LOGIN_PATH;

  const lock = async () => {
    await fetch("/api/platform/gate", { method: "DELETE" });
    router.replace(LOGIN_PATH);
    router.refresh();
  };

  return (
    <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-border bg-card px-4 lg:px-6">
      <div className="flex min-w-0 items-center gap-3">
        <Link
          href="/platform"
          className="flex items-center gap-2 text-sm font-semibold text-foreground"
        >
          <span className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <ShieldCheck className="size-4" aria-hidden="true" />
          </span>
          {t("Platform")}
        </Link>
        <span className="hidden text-xs text-muted-foreground sm:inline">
          {t("Accounts, plans and modules")}
        </span>
      </div>
      <div className="flex items-center gap-2">
        <ModeToggle />
        {!locked && (
          <>
            <Link
              href="/platform/acesso"
              className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border px-2.5 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <KeyRound className="size-4" aria-hidden="true" />
              <span className="hidden sm:inline">{t("Panel access")}</span>
            </Link>
            <button
              type="button"
              onClick={lock}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border px-2.5 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <Lock className="size-4" aria-hidden="true" />
              <span className="hidden sm:inline">{t("Lock panel")}</span>
            </button>
          </>
        )}
        <Link
          href="/dashboard"
          className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border px-2.5 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <ArrowLeft className="size-4" aria-hidden="true" />
          {t("Back to app")}
        </Link>
      </div>
    </header>
  );
}

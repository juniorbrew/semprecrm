"use client";

import Link from "next/link";
import { ArrowLeft, ShieldCheck } from "lucide-react";

import { ModeToggle } from "@/components/layout/mode-toggle";
import { useLanguage } from "@/hooks/use-language";

export function PlatformHeader() {
  const { t } = useLanguage();
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

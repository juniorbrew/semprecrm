import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft, ShieldCheck } from "lucide-react";

import { ModeToggle } from "@/components/layout/mode-toggle";

// Platform (master) admin area. Lives outside the (dashboard) group
// on purpose: no sidebar, no account-scoped shell — just a slim bar
// with a way back to the app. Access is enforced per page via
// `requirePlatformAdmin()` (404 for everyone else).
export const metadata: Metadata = {
  title: "Platform",
  robots: { index: false, follow: false, nocache: true },
};

export default function PlatformLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-screen flex-col bg-background">
      <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-border bg-card px-4 lg:px-6">
        <div className="flex min-w-0 items-center gap-3">
          <Link
            href="/platform"
            className="flex items-center gap-2 text-sm font-semibold text-foreground"
          >
            <span className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
              <ShieldCheck className="size-4" aria-hidden="true" />
            </span>
            Platform
          </Link>
          <span className="hidden text-xs text-muted-foreground sm:inline">
            Accounts, plans and modules
          </span>
        </div>
        <div className="flex items-center gap-2">
          <ModeToggle />
          <Link
            href="/dashboard"
            className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border px-2.5 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <ArrowLeft className="size-4" aria-hidden="true" />
            Back to app
          </Link>
        </div>
      </header>
      <main className="mx-auto w-full max-w-6xl flex-1 p-4 sm:p-6">{children}</main>
    </div>
  );
}

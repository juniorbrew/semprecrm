import type { Metadata } from "next";

import { PlatformHeader } from "@/components/platform/platform-header";

// Platform (master) admin area. Lives outside the (dashboard) group
// on purpose: no sidebar, no account-scoped shell — just a slim bar
// with a way back to the app. Access is enforced per page via
// `requirePlatformAdmin()` (404 for everyone else).
export const metadata: Metadata = {
  title: "Plataforma",
  robots: { index: false, follow: false, nocache: true },
};

export default function PlatformLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-screen flex-col bg-background">
      <PlatformHeader />
      <main className="mx-auto w-full max-w-6xl flex-1 p-4 sm:p-6">{children}</main>
    </div>
  );
}

import type { Metadata } from 'next';

import { PlatformHeader } from '@/components/platform/platform-header';
import { PlatformNavigation } from '@/components/platform/platform-navigation';
import { getPlatformAdmin } from '@/lib/platform/server';

// Platform (master) admin area. Lives outside the (dashboard) group
// on purpose: no sidebar, no account-scoped shell — just a slim bar
// with a way back to the app. Access is enforced per page. The gate login
// page must render before the second factor is open.
export const metadata: Metadata = {
  title: 'Plataforma',
  robots: { index: false, follow: false, nocache: true },
};

export default async function PlatformLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const ctx = await getPlatformAdmin();
  const { count, error } = ctx?.gateOpen
    ? await ctx.supabase
        .from('leads')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'novo')
    : { count: null, error: null };
  return (
    <div className="bg-background flex min-h-screen flex-col">
      <PlatformHeader />
      <main className="mx-auto w-full max-w-6xl flex-1 p-4 sm:p-6">
        {ctx?.gateOpen ? (
          <PlatformNavigation initialNewCount={error ? null : (count ?? 0)}>
            {children}
          </PlatformNavigation>
        ) : (
          children
        )}
      </main>
    </div>
  );
}

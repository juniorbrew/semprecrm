import type { Metadata } from 'next';

import { PlatformHeader } from '@/components/platform/platform-header';
import { PlatformNavigation } from '@/components/platform/platform-navigation';
import { requirePlatformAdmin } from '@/lib/platform/server';

// Platform (master) admin area. Lives outside the (dashboard) group
// on purpose: no sidebar, no account-scoped shell — just a slim bar
// with a way back to the app. Access is enforced per page via
// `requirePlatformAdmin()` (404 for everyone else).
export const metadata: Metadata = {
  title: 'Plataforma',
  robots: { index: false, follow: false, nocache: true },
};

export default async function PlatformLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = await requirePlatformAdmin();
  const { count, error } = await supabase
    .from('leads')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'novo');
  return (
    <div className="bg-background flex min-h-screen flex-col">
      <PlatformHeader />
      <main className="mx-auto w-full max-w-6xl flex-1 p-4 sm:p-6">
        <PlatformNavigation initialNewCount={error ? null : (count ?? 0)}>
          {children}
        </PlatformNavigation>
      </main>
    </div>
  );
}

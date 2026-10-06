import type { Metadata } from 'next';

import { PlatformHeader } from '@/components/platform/platform-header';
import { PlatformNavigation } from '@/components/platform/platform-navigation';
import { getPlatformAdmin } from '@/lib/platform/server';

// The platform shell is separate from the customer's CRM. The second
// login renders without the admin navigation; each protected page also
// checks requirePlatformAdmin before loading company data.
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
      {ctx?.gateOpen ? (
        <PlatformNavigation initialNewCount={error ? null : (count ?? 0)}>
          {children}
        </PlatformNavigation>
      ) : (
        <main className="mx-auto w-full max-w-6xl flex-1 p-4 sm:p-6">
          {children}
        </main>
      )}
    </div>
  );
}

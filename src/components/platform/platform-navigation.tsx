'use client';

import { createContext, useContext, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  Building2,
  LayoutDashboard,
  UserRoundPlus,
  ShieldCheck,
} from 'lucide-react';
import { useLanguage } from '@/hooks/use-language';
import { cn } from '@/lib/utils';

const LeadCountContext = createContext<{
  setNewCount: (count: number) => void;
}>({ setNewCount: () => {} });

export const useLeadCount = () => useContext(LeadCountContext);

export function PlatformNavigation({
  initialNewCount,
  children,
}: {
  initialNewCount: number | null;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const { t } = useLanguage();
  const [newCount, setNewCount] = useState(initialNewCount);
  return (
    <LeadCountContext.Provider value={{ setNewCount }}>
      <div className="flex flex-1 flex-col lg:flex-row">
        <aside className="border-border bg-card border-b lg:w-60 lg:shrink-0 lg:border-r lg:border-b-0">
          <div className="hidden items-center gap-3 px-6 py-7 lg:flex">
            <ShieldCheck className="text-primary size-6" aria-hidden="true" />
            <div>
              <p className="text-sm font-semibold">SempreCRM</p>
              <p className="text-muted-foreground mt-1 text-xs">
                {t('Platform administration')}
              </p>
            </div>
          </div>
          <nav
            aria-label={t('Platform navigation')}
            className="flex gap-1 p-3 lg:sticky lg:top-4 lg:flex-col"
          >
            {[
              { href: '/platform', label: 'Overview', icon: LayoutDashboard },
              {
                href: '/platform/accounts',
                label: 'Companies',
                icon: Building2,
              },
              { href: '/platform/leads', label: 'Leads', icon: UserRoundPlus },
            ].map(({ href, label, icon: Icon }) => {
              const active =
                href === '/platform'
                  ? pathname === href
                  : href === '/platform/accounts'
                    ? pathname !== '/platform' &&
                      pathname !== '/platform/acesso' &&
                      pathname !== '/platform/login' &&
                      !pathname.startsWith('/platform/leads')
                    : pathname.startsWith(href);
              return (
                <Link
                  key={href}
                  href={href}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'focus-visible:outline-primary flex min-h-11 flex-1 items-center justify-center gap-2 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 lg:flex-none lg:justify-start',
                    active
                      ? 'bg-primary/10 text-foreground'
                      : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                  )}
                >
                  <Icon
                    className="hidden size-4 shrink-0 sm:block"
                    aria-hidden="true"
                  />
                  {t(label)}
                  {label === 'Leads' && newCount !== null && (
                    <span
                      aria-label={`${newCount} leads novos`}
                      className="bg-primary/10 text-foreground rounded-full px-2 py-0.5 text-xs tabular-nums"
                    >
                      {newCount}
                    </span>
                  )}
                </Link>
              );
            })}
          </nav>
        </aside>
        <main
          id="platform-content"
          className="min-w-0 flex-1 p-4 sm:p-6 xl:p-8"
        >
          <div className="mx-auto max-w-7xl">{children}</div>
        </main>
      </div>
    </LeadCountContext.Provider>
  );
}

'use client';

import { createContext, useContext, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
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
  const [newCount, setNewCount] = useState(initialNewCount);
  return (
    <LeadCountContext.Provider value={{ setNewCount }}>
      <nav
        aria-label="Navegação da plataforma"
        className="border-border mb-6 flex gap-1 border-b"
      >
        {[
          { href: '/platform', label: 'Contas' },
          { href: '/platform/leads', label: 'Leads' },
        ].map(({ href, label }) => {
          const active =
            href === '/platform/leads'
              ? pathname.startsWith(href)
              : !pathname.startsWith('/platform/leads');
          return (
            <Link
              key={href}
              href={href}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'flex items-center gap-2 border-b-2 px-4 py-3 text-sm font-medium',
                active
                  ? 'border-primary text-primary'
                  : 'text-muted-foreground hover:text-foreground border-transparent'
              )}
            >
              {label}
              {label === 'Leads' && newCount !== null && (
                <span
                  aria-label={`${newCount} leads novos`}
                  className="bg-primary/10 text-primary rounded-full px-2 py-0.5 text-xs tabular-nums"
                >
                  {newCount}
                </span>
              )}
            </Link>
          );
        })}
      </nav>
      {children}
    </LeadCountContext.Provider>
  );
}

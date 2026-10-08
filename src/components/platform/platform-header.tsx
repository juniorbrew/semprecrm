'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { ArrowLeft, KeyRound, Lock, ShieldCheck } from 'lucide-react';

import { ModeToggle } from '@/components/layout/mode-toggle';
import { useLanguage } from '@/hooks/use-language';

const LOGIN_PATH = '/platform/login';

export function PlatformHeader() {
  const { t } = useLanguage();
  const pathname = usePathname();
  const router = useRouter();
  // On the lock screen the panel is closed: no access link, no lock button.
  const locked = pathname === LOGIN_PATH;

  const lock = async () => {
    await fetch('/api/platform/gate', { method: 'DELETE' });
    router.replace(LOGIN_PATH);
    router.refresh();
  };

  return (
    <header className="border-border bg-card flex h-14 shrink-0 items-center justify-between gap-3 border-b px-4 lg:px-6">
      <div className="flex min-w-0 items-center gap-3">
        <Link
          href="/platform"
          className="text-foreground flex min-w-0 items-center gap-2 text-sm font-semibold"
        >
          <span className="bg-primary text-primary-foreground flex size-8 shrink-0 items-center justify-center rounded-lg">
            <ShieldCheck className="size-4" aria-hidden="true" />
          </span>
          <span className="truncate">{t('Platform administration')}</span>
        </Link>
        <span className="text-muted-foreground hidden text-xs sm:inline">
          {t(
            pathname.startsWith('/platform/plans')
              ? 'Plans'
              : pathname.startsWith('/platform/leads')
                ? 'Leads'
                : pathname === '/platform'
                  ? 'Overview'
                  : 'Companies'
          )}
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <ModeToggle />
        {!locked && (
          <>
            <Link
              href="/platform/acesso"
              aria-label={t('Panel access')}
              className="border-border text-muted-foreground hover:bg-muted hover:text-foreground inline-flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-sm transition-colors"
            >
              <KeyRound className="size-4" aria-hidden="true" />
              <span className="hidden sm:inline">{t('Panel access')}</span>
            </Link>
            <button
              type="button"
              onClick={lock}
              aria-label={t('Lock panel')}
              className="border-border text-muted-foreground hover:bg-muted hover:text-foreground inline-flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-sm transition-colors"
            >
              <Lock className="size-4" aria-hidden="true" />
              <span className="hidden sm:inline">{t('Lock panel')}</span>
            </button>
          </>
        )}
        <Link
          href="/dashboard"
          aria-label={t('Back to app')}
          className="border-border text-muted-foreground hover:bg-muted hover:text-foreground inline-flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-sm transition-colors"
        >
          <ArrowLeft className="size-4" aria-hidden="true" />
          <span className="hidden sm:inline">{t('Back to app')}</span>
        </Link>
      </div>
    </header>
  );
}

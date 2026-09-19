'use client';

import Link from 'next/link';
import { SearchX } from 'lucide-react';

import { useLanguage } from '@/hooks/use-language';
import { Button } from '@/components/ui/button';

/**
 * Root 404 — replaces Next's built-in English "This page could not be
 * found." for every unmatched URL. Rendered inside the root layout, so
 * the theme and the language provider are already in place.
 */
export default function NotFound() {
  const { t } = useLanguage();
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-md rounded-2xl border border-border bg-card p-8 text-center shadow-sm">
        <div className="mx-auto mb-5 flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <SearchX className="size-6" aria-hidden="true" />
        </div>
        <h1 className="text-xl font-semibold text-foreground">{t('Page not found')}</h1>
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
          {t('The address you opened does not exist or was moved. Check the link or go back to the start.')}
        </p>
        <div className="mt-6 flex justify-center">
          <Button nativeButton={false} render={<Link href="/" />}>
            {t('Go to the start')}
          </Button>
        </div>
      </div>
    </div>
  );
}

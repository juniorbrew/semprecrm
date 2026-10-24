'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { Lock } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { useLanguage } from '@/hooks/use-language';
import { useReadOnly } from '@/hooks/use-read-only';
import { setClientReadOnlyReason } from '@/lib/billing/read-only-db-error';
import type { ReadOnlyReason } from '@/lib/billing/read-only';

/** English keys; the dictionary (i18n-dict/billing.ts) carries the pt-BR. */
const COPY: Record<ReadOnlyReason, { text: string; action: string }> = {
  trial_expired: {
    text: 'Your trial has ended. The account is read-only: you can see everything, but sending messages, broadcasts, automations and AI replies are paused. Incoming messages keep arriving. Scheduled messages, automation waits and satisfaction surveys that come due meanwhile are not sent: they fail with a visible reason.',
    action: 'Subscribe',
  },
  past_due: {
    text: 'A payment is overdue. The account is read-only: you can see everything, but sending messages, broadcasts, automations and AI replies are paused. Incoming messages keep arriving. Scheduled messages, automation waits and satisfaction surveys that come due meanwhile are not sent: they fail with a visible reason.',
    action: 'Pay now',
  },
};

/**
 * Persistent notice shown while the account is read-only (trial ended /
 * payment overdue). The owner gets the button to Settings → Plano; everyone
 * else is told whom to ask. Renders nothing for an active account.
 */
export function ReadOnlyBanner() {
  const { t } = useLanguage();
  const { readOnly, reason, isOwner } = useReadOnly();
  // Tells the Supabase client to word a database-refused write (094) as read-only.
  useEffect(() => {
    setClientReadOnlyReason(reason);
    return () => setClientReadOnlyReason(null);
  }, [reason]);
  if (!readOnly || !reason) return null;
  const copy = COPY[reason];
  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-amber-500/30 bg-amber-500/10 px-4 py-2.5 text-sm text-foreground sm:px-6"
    >
      <Lock className="size-4 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden="true" />
      <p className="min-w-0 flex-1 basis-80">{t(copy.text)}</p>
      {isOwner ? (
        <Button size="sm" nativeButton={false} render={<Link href="/settings?tab=plan" />}>
          {t(copy.action)}
        </Button>
      ) : (
        <span className="text-muted-foreground text-xs">{t('Ask the account owner to subscribe.')}</span>
      )}
    </div>
  );
}

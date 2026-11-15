import { toast } from 'sonner';

import { formatBrl } from '@/lib/billing/overview';

export interface ExtraOfferPayload {
  kind: 'user' | 'channel';
  monthlyCents: number;
}

/** Reads the `offer` the limit errors carry (migration 114), or null. */
export function readExtraOffer(body: unknown): ExtraOfferPayload | null {
  const o = (body as { offer?: Partial<ExtraOfferPayload> } | null)?.offer;
  return o && (o.kind === 'user' || o.kind === 'channel') && typeof o.monthlyCents === 'number' && Number.isSafeInteger(o.monthlyCents)
    ? { kind: o.kind, monthlyCents: o.monthlyCents }
    : null;
}

/**
 * The limit error as a toast; when the plan sells one more, the toast also
 * carries "Buy 1 extra for R$ X/month", which goes to Settings → Plano.
 */
export function limitToast(message: string, offer: ExtraOfferPayload | null, t: (key: string) => string, go: (href: string) => void) {
  toast.error(
    message,
    offer
      ? {
          duration: 12000,
          action: {
            label: `${t('Buy 1 extra for')} ${formatBrl(offer.monthlyCents)}${t('/month')}`,
            onClick: () => go('/settings?tab=plan'),
          },
        }
      : undefined,
  );
}

import { toast } from 'sonner';

import { formatBrl } from '@/lib/billing/overview';

export interface ExtraOfferPayload {
  kind: 'user' | 'channel';
  monthlyCents: number;
  canBuy: boolean;
}

/** Reads the `offer` the limit errors carry (migration 116), or null. */
export function readExtraOffer(body: unknown): ExtraOfferPayload | null {
  const o = (body as { offer?: Partial<ExtraOfferPayload> } | null)?.offer;
  return o && (o.kind === 'user' || o.kind === 'channel') && typeof o.monthlyCents === 'number' && Number.isSafeInteger(o.monthlyCents)
    ? { kind: o.kind, monthlyCents: o.monthlyCents, canBuy: o.canBuy === true }
    : null;
}

/**
 * The limit error as a toast. When the plan sells one more: the owner gets "Buy 1 extra for
 * R$ X/month" (goes to Settings → Plano); anyone else is told to ask the owner.
 */
export function limitToast(message: string, offer: ExtraOfferPayload | null, t: (key: string) => string, go: (href: string) => void) {
  const price = offer ? `${formatBrl(offer.monthlyCents)}${t('/month')}` : '';
  if (!offer) {
    toast.error(message);
  } else if (offer.canBuy) {
    toast.error(message, {
      duration: 12000,
      action: { label: `${t('Buy 1 extra for')} ${price}`, onClick: () => go('/settings?tab=plan') },
    });
  } else {
    toast.error(message, { duration: 12000, description: `${t('Ask the account owner to add 1 extra for')} ${price}.` });
  }
}

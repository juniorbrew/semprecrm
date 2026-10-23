import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/automations/admin-client', () => ({ supabaseAdmin: () => ({}) }));
vi.mock('@/lib/audit-server', () => ({ audit: vi.fn() }));
vi.mock('@/lib/plan-catalog-server', () => ({ loadCurrentPlanCatalog: vi.fn() }));
vi.mock('@/lib/billing/asaas', () => ({ asaasConfigured: () => true, AsaasError: class extends Error {} }));

import { CHECKOUT_ERRORS } from '@/app/api/billing/checkout/route';
import { paymentStatusKey } from '@/lib/billing/overview';
import { translateLiteral } from '@/lib/i18n';

import { DICT_BILLING } from './billing';

describe('billing dictionary', () => {
  it('translates every checkout API message and every charge status label to pt-BR', () => {
    const keys = [
      ...Object.values(CHECKOUT_ERRORS),
      ...['PENDING', 'OVERDUE', 'RECEIVED', 'REFUNDED', 'CHARGEBACK_REQUESTED', 'SOMETHING_ELSE'].map(paymentStatusKey),
    ];
    for (const key of keys) {
      expect(DICT_BILLING[key], key).toBeTruthy();
      expect(translateLiteral(key, 'pt-BR'), key).not.toBe(key);
    }
  });

  it('has no empty or untranslated values', () => {
    for (const [en, pt] of Object.entries(DICT_BILLING)) {
      expect(pt.trim(), en).not.toBe('');
      expect(pt, en).not.toBe(en);
    }
  });
});

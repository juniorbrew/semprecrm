// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';

import { translateLiteral } from '@/lib/i18n';

const h = vi.hoisted(() => ({ isOwner: true }));
vi.mock('@/hooks/use-auth', () => ({
  useAuth: () => ({ signOut: () => {}, account: { name: 'Acme' }, isOwner: h.isOwner }),
}));
vi.mock('@/hooks/use-language', () => ({
  useLanguage: () => ({ t: (k: string) => translateLiteral(k, 'pt-BR'), language: 'pt-BR' }),
}));

import { BlockedScreen } from './blocked-screen';

afterEach(cleanup);

function planLink(reason: Parameters<typeof BlockedScreen>[0]['reason']) {
  const { container } = render(<BlockedScreen reason={reason} />);
  return container.querySelector('a[href="/settings?tab=plan"]')?.textContent;
}

describe('BlockedScreen plan action', () => {
  it.each(['canceled', 'past_due', 'trial_expired'] as const)('the owner gets "Assinar" for %s', (reason) => {
    h.isOwner = true;
    expect(planLink(reason)).toBe('Assinar');
  });

  it.each(['suspended', 'plan_unavailable'] as const)('the owner only gets "Ver plano" for %s', (reason) => {
    h.isOwner = true;
    expect(planLink(reason)).toBe('Ver plano');
  });

  it('others only get "Ver plano"', () => {
    h.isOwner = false;
    expect(planLink('canceled')).toBe('Ver plano');
  });
});

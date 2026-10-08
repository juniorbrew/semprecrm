import { beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ context: {} as Record<string, unknown> }));
vi.mock('react', async () => ({
  ...(await vi.importActual('react')),
  useContext: () => h.context,
}));
import { useEntitlements } from './use-auth';
import { resolveEntitlements } from '@/lib/plans';
beforeEach(() => {
  h.context = {
    entitlements: resolveEntitlements(null),
    profileLoading: false,
    account: null,
    user: { id: 'signed-in' },
  };
});
it('shows recoverable unavailability after an authenticated account read fails', () => {
  expect(useEntitlements().ready).toBe(true);
  expect(useEntitlements().blocked).toEqual({ reason: 'plan_unavailable' });
});
it('waits while loading or without an authenticated user', () => {
  h.context.profileLoading = true;
  expect(useEntitlements().ready).toBe(false);
  h.context.profileLoading = false;
  h.context.user = null;
  expect(useEntitlements().ready).toBe(false);
});

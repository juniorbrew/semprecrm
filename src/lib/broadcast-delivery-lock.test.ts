import { describe, expect, it } from 'vitest';
import { DELIVERY_LOCK_STALE_MS, isDeliveryLockActive } from './broadcast-delivery-lock';

describe('isDeliveryLockActive', () => {
  const now = Date.parse('2026-09-27T12:00:00Z');

  it('is inactive without a lock', () => {
    expect(isDeliveryLockActive(null, now)).toBe(false);
    expect(isDeliveryLockActive(undefined, now)).toBe(false);
    expect(isDeliveryLockActive('garbage', now)).toBe(false);
  });

  it('is active inside the staleness window', () => {
    expect(isDeliveryLockActive('2026-09-27T11:55:00Z', now)).toBe(true);
  });

  it('is stale (resumable) once the window passes', () => {
    const stale = new Date(now - DELIVERY_LOCK_STALE_MS - 1).toISOString();
    expect(isDeliveryLockActive(stale, now)).toBe(false);
  });
});

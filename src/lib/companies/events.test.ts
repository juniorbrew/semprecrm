import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { notifyContactCompaniesChanged, onContactCompaniesChanged } from './events';

// Node has EventTarget / CustomEvent but no `window`; a bare
// EventTarget is all the helpers use.
beforeEach(() => {
  vi.stubGlobal('window', new EventTarget());
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('contact companies changed event', () => {
  it('delivers the contact id to subscribers until they unsubscribe', () => {
    const handler = vi.fn();
    const off = onContactCompaniesChanged(handler);
    notifyContactCompaniesChanged('contact-1');
    expect(handler).toHaveBeenCalledWith('contact-1');
    off();
    notifyContactCompaniesChanged('contact-2');
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

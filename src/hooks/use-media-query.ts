'use client';

import { useCallback, useSyncExternalStore } from 'react';

/**
 * Live `matchMedia` result. `serverValue` is what the server render (and
 * the first hydration pass) assumes; the client corrects it right after.
 */
export function useMediaQuery(query: string, serverValue = false): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const mql = window.matchMedia(query);
      mql.addEventListener('change', onChange);
      return () => mql.removeEventListener('change', onChange);
    },
    [query],
  );
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => serverValue,
  );
}

/** Phone/tablet keyboards: no Shift+Enter, so Enter must insert a new line. */
export const TOUCH_KEYBOARD_QUERY = '(hover: none) and (pointer: coarse)';

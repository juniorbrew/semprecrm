'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import type { AddressLookup, CompanyLookup } from '@/lib/br/lookup';

/**
 * Lookup state machine shared by the CNPJ and CEP inputs.
 *
 *   idle → loading → found | not_found | error
 *
 * `key` is the normalised document the state refers to, so the input
 * can tell a stale result ("found" for the CNPJ the user has since
 * edited) from a current one. Only one request is in flight per hook;
 * a new key aborts the previous fetch.
 */
export type LookupStatus = 'idle' | 'loading' | 'found' | 'not_found' | 'error';

export interface LookupState<T> {
  status: LookupStatus;
  key: string;
  data: T | null;
}

const IDLE = { status: 'idle', key: '', data: null } as const;

function useLookup<T>(
  buildUrl: (key: string) => string,
  pick: (json: Record<string, unknown>) => T,
) {
  const [state, setState] = useState<LookupState<T>>(IDLE);
  const abortRef = useRef<AbortController | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancel = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  const reset = useCallback(() => {
    cancel();
    setState(IDLE);
  }, [cancel]);

  /**
   * Look `key` up after a short debounce. Resolves with the data (or
   * null) so callers can fill the form in the same tick the state
   * flips to `found`.
   */
  const lookup = useCallback(
    (key: string, debounceMs = 250): Promise<T | null> =>
      new Promise((resolve) => {
        cancel();
        setState({ status: 'loading', key, data: null });
        timerRef.current = setTimeout(async () => {
          const controller = new AbortController();
          abortRef.current = controller;
          try {
            const res = await fetch(buildUrl(key), { signal: controller.signal });
            if (controller.signal.aborted) return resolve(null);
            if (res.status === 404 || res.status === 422) {
              setState({ status: 'not_found', key, data: null });
              return resolve(null);
            }
            if (!res.ok) {
              setState({ status: 'error', key, data: null });
              return resolve(null);
            }
            const json = (await res.json()) as Record<string, unknown>;
            const data = pick(json);
            setState({ status: 'found', key, data });
            resolve(data);
          } catch (err) {
            if ((err as { name?: string })?.name === 'AbortError') return resolve(null);
            setState({ status: 'error', key, data: null });
            resolve(null);
          }
        }, debounceMs);
      }),
    [buildUrl, pick, cancel],
  );

  useEffect(() => cancel, [cancel]);

  return { state, lookup, reset };
}

const cnpjUrl = (cnpj: string) => `/api/lookup/cnpj/${encodeURIComponent(cnpj)}`;
const pickCompany = (json: Record<string, unknown>) => json.company as CompanyLookup;

export function useCnpjLookup() {
  return useLookup<CompanyLookup>(cnpjUrl, pickCompany);
}

const cepUrl = (cep: string) => `/api/lookup/cep/${encodeURIComponent(cep)}`;
const pickAddress = (json: Record<string, unknown>) => json.address as AddressLookup;

export function useCepLookup() {
  return useLookup<AddressLookup>(cepUrl, pickAddress);
}

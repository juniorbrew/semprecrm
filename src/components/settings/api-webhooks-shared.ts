import { useCallback, useState } from 'react';

/** fetch + JSON; throws Error(<server message>) so callers can toast `t(message)`. */
export async function apiJson<T = unknown>(url: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(url, {
    cache: 'no-store',
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
  const body = (await res.json().catch(() => ({}))) as { error?: string } & Record<string, unknown>;
  if (!res.ok) throw new Error(typeof body.error === 'string' ? body.error : 'Something went wrong');
  return body as T;
}

/** Copy to clipboard; `copied` holds the id of the last copied thing for ~2 s. */
export function useCopy() {
  const [copied, setCopied] = useState<string | null>(null);
  const copy = useCallback(async (id: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(id);
      setTimeout(() => setCopied((c) => (c === id ? null : c)), 2000);
    } catch {
      // clipboard blocked: the text is selectable on screen
    }
  }, []);
  return { copied, copy };
}

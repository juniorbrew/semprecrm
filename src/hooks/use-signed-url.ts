"use client";

import { useEffect, useState } from "react";

import { createClient } from "@/lib/supabase/client";
import { CHAT_INTERNAL_BUCKET, CHAT_SIGNED_URL_SECONDS } from "@/lib/chat/attachments";

interface CacheEntry {
  url: string;
  /** Epoch ms after which the URL is treated as stale (a bit before expiry). */
  until: number;
}

/** Module-level cache so a re-render or a second bubble never re-signs. */
const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<string>>();

/** Refresh when less than this is left, so an open page never hands out a dead link. */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

function cacheKey(bucket: string, path: string, download: string | undefined): string {
  return `${bucket}|${path}|${download ?? ""}`;
}

/**
 * Sign (or reuse) a 1-hour URL for an object in a private bucket.
 * Pass `download` (a file name) for a Content-Disposition: attachment
 * link. Rejects when the caller has no read access to the object.
 */
export async function getSignedUrl(
  path: string,
  opts: { bucket?: string; download?: string } = {},
): Promise<string> {
  const bucket = opts.bucket ?? CHAT_INTERNAL_BUCKET;
  const key = cacheKey(bucket, path, opts.download);
  const hit = cache.get(key);
  if (hit && hit.until > Date.now()) return hit.url;
  const pending = inflight.get(key);
  if (pending) return pending;
  const p = (async () => {
    const supabase = createClient();
    const { data, error } = await supabase.storage
      .from(bucket)
      .createSignedUrl(path, CHAT_SIGNED_URL_SECONDS, opts.download ? { download: opts.download } : undefined);
    if (error || !data?.signedUrl) throw new Error(error?.message ?? "Could not sign the URL");
    cache.set(key, { url: data.signedUrl, until: Date.now() + CHAT_SIGNED_URL_SECONDS * 1000 - REFRESH_MARGIN_MS });
    return data.signedUrl;
  })();
  inflight.set(key, p);
  try {
    return await p;
  } finally {
    inflight.delete(key);
  }
}

/** Drop a cached URL (after the object was deleted, for instance). */
export function forgetSignedUrl(path: string, bucket: string = CHAT_INTERNAL_BUCKET): void {
  for (const key of [...cache.keys()]) if (key.startsWith(`${bucket}|${path}|`)) cache.delete(key);
}

export interface SignedUrlState {
  url: string | null;
  loading: boolean;
  error: string | null;
}

/**
 * Signed URL for rendering an attachment inline (image / video /
 * audio). `null` path → idle. The URL is re-signed when it nears
 * expiry while the component stays mounted.
 */
export function useSignedUrl(path: string | null | undefined, bucket: string = CHAT_INTERNAL_BUCKET): SignedUrlState {
  const key = path ? cacheKey(bucket, path, undefined) : null;
  // Start from the cache when possible so a re-mount never flashes a
  // spinner; the effect below re-validates expiry outside render.
  const [state, setState] = useState<SignedUrlState>(() => {
    const hit = key ? cache.get(key) : undefined;
    return { url: hit?.url ?? null, loading: !!path && !hit, error: null };
  });
  // Path change while mounted: reset during render (no effect round trip).
  const [prevKey, setPrevKey] = useState(key);
  if (key !== prevKey) {
    setPrevKey(key);
    setState({ url: null, loading: !!path, error: null });
  }

  useEffect(() => {
    if (!path) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const load = async () => {
      try {
        // Resolves from the cache when fresh, otherwise signs a new URL.
        const url = await getSignedUrl(path, { bucket });
        if (cancelled) return;
        setState({ url, loading: false, error: null });
        const entry = cache.get(cacheKey(bucket, path, undefined));
        const delay = Math.max(30_000, (entry?.until ?? Date.now()) - Date.now());
        timer = setTimeout(() => void load(), delay);
      } catch (err) {
        if (cancelled) return;
        setState({ url: null, loading: false, error: err instanceof Error ? err.message : String(err) });
      }
    };
    void load();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [path, bucket]);

  return state;
}
